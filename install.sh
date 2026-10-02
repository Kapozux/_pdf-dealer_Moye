#!/bin/zsh
# 墨页 · 一键安装
#
#   在仓库里：   ./install.sh            （或双击「一键安装.command」）
#   全新机器：   curl -fsSL https://raw.githubusercontent.com/Kapozux/_pdf-dealer_Moye/main/install.sh | zsh
#
# 设计原则：
#   - 不需要 Homebrew、不需要 sudo。Node 和 Python 都装进项目自己的目录（.runtime/、.venv/），
#     删掉项目文件夹就是卸载干净（再加上 ./uninstall.sh 撤掉开机自启）。
#   - 必需的只有：Node、npm 依赖、一个带 pypdfium2 + Pillow 的小 Python 环境（约 60MB，
#     AI 模式渲染页面、图片转 PDF 都靠它）。
#   - 其余都是可选组件，问一句再装；非交互（管道、页面里点按钮）时按默认值走。
#   - 可重复运行：已经装好的每一步都会跳过。
#
# 单独装某个组件（页面「设置 → 环境」里的按钮就是这么调用的）：
#   ./install.sh --only surya|browser|libreoffice|ollama|python
#   ./install.sh --only ollama-model --model qwen3-vl:8b-instruct
#
# 其它开关：--yes（全部按默认值，不提问）、--with-surya / --no-surya、--with-ollama / --no-ollama、
#           --with-libreoffice / --no-libreoffice、--no-browser、--no-services（不注册开机自启）

set -euo pipefail

# MOYE_REPO_TARBALL 可以指到别的包（fork、某个 tag，或测试用的本地 file:// 包）
REPO_TARBALL="${MOYE_REPO_TARBALL:-https://codeload.github.com/Kapozux/_pdf-dealer_Moye/tar.gz/refs/heads/main}"
NODE_MIN="22.13.0"
OLLAMA_URL="${MOYE_OLLAMA_URL:-http://127.0.0.1:11434}"

# ---------- 输出 ----------
if [[ -t 1 ]]; then
  c_dim=$'\e[2m'; c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_b=$'\e[1m'; c_0=$'\e[0m'
else
  c_dim=""; c_ok=""; c_warn=""; c_err=""; c_b=""; c_0=""
fi
step() { print -r -- "${c_b}▸ $*${c_0}"; }
ok()   { print -r -- "  ${c_ok}✓${c_0} $*"; }
warn() { print -r -- "  ${c_warn}!${c_0} $*"; }
die()  { print -r -- "${c_err}✗ $*${c_0}" >&2; exit 1; }
info() { print -r -- "  ${c_dim}$*${c_0}"; }
# 终端里画进度条；被页面「环境」按钮调起时（没有终端）不画，免得几百个 \r 灌进日志
if [[ -t 2 ]]; then dl_flags=(--progress-bar); else dl_flags=(-sS); fi

# ---------- 参数 ----------
orig_args=("$@")
only=""; model=""; assume_yes="${MOYE_YES:-}"
want_surya=""; want_ollama=""; want_office=""; want_browser="yes"; want_services="yes"
while (( $# )); do
  case "$1" in
    --only) only="$2"; shift ;;
    --model) model="$2"; shift ;;
    --yes|-y) assume_yes=1 ;;
    --with-surya) want_surya=yes ;;
    --with-ollama) want_ollama=yes ;;
    --with-libreoffice) want_office=yes ;;
    --no-ollama) want_ollama=no ;;
    --no-surya) want_surya=no ;;
    --no-libreoffice) want_office=no ;;
    --no-browser) want_browser=no ;;
    --no-services) want_services=no ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "不认识的参数：$1（--help 看用法）" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || die "墨页目前只支持 macOS。"
arch="$(uname -m)"   # arm64 | x86_64

# 能不能提问：管道安装时 stdin 是脚本本身，要从 /dev/tty 读
can_ask() { [[ -z "$assume_yes" ]] && { : </dev/tty; } 2>/dev/null; }
# ask "问题" y|n  → 返回 0 = 是
ask() {
  local question="$1" default="$2" answer=""
  if ! can_ask; then [[ "$default" == y ]]; return; fi
  local hint="[y/N]"; [[ "$default" == y ]] && hint="[Y/n]"
  print -rn -- "  ${c_b}?${c_0} $question $hint " >/dev/tty
  read -r answer </dev/tty || answer=""
  answer="${answer:-$default}"
  [[ "$answer" == [yY]* ]]
}

# ---------- 找到项目目录（或者先把项目下载下来） ----------
script_dir=""
if [[ -n "${ZSH_ARGZERO:-}" && -f "${ZSH_ARGZERO:A}" ]]; then script_dir="${ZSH_ARGZERO:A:h}"; fi
if [[ -n "$script_dir" && -f "$script_dir/package.json" && -f "$script_dir/local-ocr-server.mjs" ]]; then
  project_dir="$script_dir"
else
  # curl | zsh：没有仓库，先下载到 ~/Moye（MOYE_HOME 可改），再用那份脚本继续
  target="${MOYE_HOME:-$HOME/Moye}"
  step "下载墨页到 $target"
  if [[ -f "$target/package.json" ]]; then
    ok "已存在，直接使用（要更新请先删掉这个目录）"
  else
    mkdir -p "$target"
    curl -fsSL "$REPO_TARBALL" | tar -xz -C "$target" --strip-components 1 || die "下载失败，检查网络后重试。"
    ok "下载完成"
  fi
  exec /bin/zsh "$target/install.sh" "${orig_args[@]}"
fi
cd -- "$project_dir"
runtime="$project_dir/.runtime"
mkdir -p "$runtime" "$project_dir/logs"

# ---------- Node ----------
version_ge() {  # version_ge 22.14.0 22.13.0
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == "$2" ]]
}
find_node_dir() {
  local candidate
  for candidate in "${MOYE_NODE_DIR:-}" "$runtime/node/bin" "$(dirname "$(command -v node 2>/dev/null || echo /nonexistent/node)")" /opt/homebrew/bin /usr/local/bin; do
    [[ -n "$candidate" && -x "$candidate/node" && -x "$candidate/npm" ]] || continue
    local v; v="$("$candidate/node" -v 2>/dev/null | tr -d v)" || continue
    if version_ge "$v" "$NODE_MIN"; then print -r -- "$candidate"; return 0; fi
  done
  return 1
}
ensure_node() {
  step "Node.js（≥ $NODE_MIN）"
  if node_dir="$(find_node_dir)"; then
    ok "使用 $node_dir/node（$("$node_dir/node" -v)）"
  else
    # 装进项目的 .runtime/node：不用 sudo，也不碰系统里别的 Node
    local node_arch="arm64"; [[ "$arch" == x86_64 ]] && node_arch="x64"
    local base="https://nodejs.org/dist/latest-v22.x"
    local sums; sums="$(curl -fsSL "$base/SHASUMS256.txt")" || die "连不上 nodejs.org。"
    local file; file="$(print -r -- "$sums" | awk -v a="darwin-$node_arch.tar.gz" '$2 ~ a"$" {print $2}' | head -1)"
    local sha; sha="$(print -r -- "$sums" | awk -v f="$file" '$2 == f {print $1}')"
    [[ -n "$file" && -n "$sha" ]] || die "没找到适合这台 Mac 的 Node 安装包。"
    info "下载 $file …"
    curl -fL "${dl_flags[@]}" "$base/$file" -o "$runtime/$file"
    [[ "$(shasum -a 256 "$runtime/$file" | awk '{print $1}')" == "$sha" ]] || { rm -f "$runtime/$file"; die "Node 安装包校验失败，已删除，请重试。"; }
    rm -rf "$runtime/node" && mkdir -p "$runtime/node"
    tar -xzf "$runtime/$file" -C "$runtime/node" --strip-components 1 && rm -f "$runtime/$file"
    node_dir="$runtime/node/bin"
    ok "已装到 .runtime/node（$("$node_dir/node" -v)）"
  fi
  export PATH="$node_dir:$PATH"
}

ensure_npm_deps() {
  step "项目依赖"
  if [[ -d node_modules/vinext && -d node_modules/pdfjs-dist ]]; then
    ok "已安装"
  else
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund
    ok "安装完成"
  fi
}

# ---------- Python（uv 管理，自动下载 Python 3.12，不碰系统 Python） ----------
ensure_uv() {
  uv_bin="$(command -v uv 2>/dev/null || true)"
  for candidate in "$runtime/uv/uv" "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
    [[ -z "$uv_bin" && -x "$candidate" ]] && uv_bin="$candidate"
  done
  if [[ -z "$uv_bin" ]]; then
    info "下载 uv（Python 环境管理器）…"
    # UV_UNMANAGED_INSTALL：装进指定目录，不改 shell 配置文件
    curl -fsSL https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="$runtime/uv" sh >/dev/null
    uv_bin="$runtime/uv/uv"
    [[ -x "$uv_bin" ]] || die "uv 安装失败。"
  fi
  export UV_PYTHON_INSTALL_DIR="$runtime/python"   # uv 下载的 Python 也放项目里
}
find_venv() {
  local dir
  for dir in "${MOYE_VENV:-}" "$project_dir/.venv" "$project_dir/../.venv-marker"; do
    [[ -n "$dir" && -x "$dir/bin/python" ]] && { print -r -- "${dir:A}"; return 0; }
  done
  return 1
}
ensure_python() {
  step "Python 环境（页面渲染、图片处理）"
  ensure_uv
  if ! venv_dir="$(find_venv)"; then
    venv_dir="$project_dir/.venv"
    "$uv_bin" venv "$venv_dir" --python 3.12 --quiet
  fi
  if "$venv_dir/bin/python" -c "import pypdfium2, PIL" 2>/dev/null; then
    ok "已就绪（$venv_dir）"
  else
    "$uv_bin" pip install --python "$venv_dir/bin/python" --quiet pypdfium2 pillow
    ok "已安装 pypdfium2 + Pillow（$venv_dir）"
  fi
}

# ---------- 可选组件 ----------
# 注意：这些函数都是在 `install_x || failures+=(…)` 里调用的，zsh 在 || 左边会**关掉 set -e**，
# 函数里某条命令失败也会接着往下跑、最后打出「✓ 安装完成」（全新安装实测踩到过：浏览器压缩包坏了，
# 却报成功）。所以每条可能失败的命令都要显式 `|| { warn …; return 1; }`。

# ---------- 可选：Surya 本地高精度识别 ----------
install_surya() {
  step "Surya 本地高精度识别（约 1GB，首次识别再下载约 1GB 模型）"
  [[ -n "${venv_dir:-}" ]] || ensure_python
  # Surya 2 靠 llama.cpp 的 llama-server 跑模型（SURYA_INFERENCE_BACKEND=llamacpp）
  if ! command -v llama-server >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/llama-server && ! -x /usr/local/bin/llama-server ]]; then
    if command -v brew >/dev/null 2>&1; then
      info "安装 llama.cpp（Surya 的推理引擎）…"
      brew install llama.cpp || { warn "llama.cpp 安装失败。"; return 1; }
    else
      warn "Surya 需要 llama.cpp，而这台 Mac 没有 Homebrew。先装 Homebrew（https://brew.sh），再运行：./install.sh --only surya"
      return 1
    fi
  fi
  if [[ -x "$venv_dir/bin/surya_ocr" ]]; then
    ok "已安装"
  else
    "$uv_bin" pip install --python "$venv_dir/bin/python" surya-ocr || { warn "surya-ocr 安装失败。"; return 1; }
    ok "安装完成"
  fi
}

# ---------- 可选：Markdown → PDF 用的无头浏览器 ----------
install_browser() {
  step "PDF 导出用的无头浏览器（约 100MB，独立于你的 Chrome）"
  # (N)：匹配不到时给空数组。zsh 默认匹配不到通配符直接报错退出——全新安装时第一次跑就踩到过
  local found=(data/browser/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell(N))
  if (( ${#found} )); then
    ok "已安装"
    return 0
  fi
  local attempt dir bins
  for attempt in 1 2; do
    if npm run --silent browser:install; then
      found=(data/browser/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell(N))
      (( ${#found} )) && { ok "安装完成"; return 0; }
    fi
    # 下载中断会留下半截目录，之后每次都被它挡住（"An earlier install of this build probably did not finish"），
    # 实测第一次下载的压缩包是坏的，第二次就再也装不上了。清掉没有可执行文件的版本目录和残留 zip 再试。
    for dir in data/browser/chrome-headless-shell/*(N/); do
      bins=("$dir"/chrome-headless-shell-*/chrome-headless-shell(N))
      (( ${#bins} )) || rm -rf "$dir"
    done
    rm -f data/browser/chrome-headless-shell/*.zip(N)
    (( attempt == 1 )) && warn "下载没成功，清理残留后重试一次…"
  done
  warn "无头浏览器没装上（网络问题？）。之后在「设置 → 环境」里重试，或运行：./install.sh --only browser"
  return 1
}

# ---------- 可选：LibreOffice（PPT / Word） ----------
find_soffice() {
  command -v soffice 2>/dev/null && return 0
  local path
  for path in /Applications/LibreOffice.app/Contents/MacOS/soffice "$HOME/Applications/LibreOffice.app/Contents/MacOS/soffice"; do
    [[ -x "$path" ]] && { print -r -- "$path"; return 0; }
  done
  return 1
}
install_libreoffice() {
  step "LibreOffice（转 PPT / Word，约 700MB）"
  if find_soffice >/dev/null; then
    ok "已安装"
  elif command -v brew >/dev/null 2>&1; then
    brew install --cask libreoffice || { warn "LibreOffice 安装失败。"; return 1; }
    ok "安装完成"
  else
    warn "没有 Homebrew，无法自动安装。去 https://www.libreoffice.org/download/ 下载安装即可，墨页会自动找到它。"
    return 1
  fi
}

# ---------- 可选：Ollama（本机视觉模型，不要 Key、图片不出这台机器） ----------
ollama_up() { curl -fs --max-time 3 "$OLLAMA_URL/api/version" >/dev/null 2>&1; }
install_ollama() {
  step "Ollama（本机 AI 模型运行环境）"
  if ollama_up; then
    ok "已在运行"
    return 0
  fi
  local app=""
  for candidate in /Applications/Ollama.app "$HOME/Applications/Ollama.app"; do
    [[ -d "$candidate" ]] && app="$candidate"
  done
  if [[ -z "$app" ]] && ! command -v ollama >/dev/null 2>&1; then
    info "下载 Ollama …"
    local zip="$runtime/Ollama-darwin.zip"
    curl -fL "${dl_flags[@]}" https://ollama.com/download/Ollama-darwin.zip -o "$zip" || { rm -f "$zip"; warn "Ollama 下载失败。"; return 1; }
    # /Applications 不可写（非管理员账户）就装到 ~/Applications
    local dest=/Applications; [[ -w "$dest" ]] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
    ditto -xk "$zip" "$dest" || { rm -f "$zip"; warn "Ollama 解压失败（压缩包可能不完整），请重试。"; return 1; }
    rm -f "$zip"
    app="$dest/Ollama.app"
    ok "已装到 $app"
  fi
  if [[ -n "$app" ]]; then
    open -g "$app"
  else
    (ollama serve >/dev/null 2>&1 &)
  fi
  info "等待 Ollama 启动…"
  for _ in {1..60}; do ollama_up && { ok "Ollama 已启动"; return 0; }; sleep 1; done
  warn "Ollama 没在 60 秒内启动。打开「应用程序」里的 Ollama 后再试。"
  return 1
}

# 按内存推荐模型：模型本体 + 16k 上下文的缓存都要常驻内存
recommended_model() {
  local mem_gb=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
  if (( mem_gb >= 16 )); then print qwen3-vl:8b-instruct; else print qwen3-vl:4b-instruct; fi
}
# 模型下载源。Ollama 官方库的模型文件放在 Cloudflare R2 上，2026-09-24 在国内网络实测：
# 约 100KB/s，而且分块反复断开，最后 "max retries exceeded" 直接放弃（走系统代理也一样，
# Ollama 不读 macOS 的系统代理）。魔搭（ModelScope）有同一个模型的 Ollama 格式——模型本体 +
# 视觉投影（projector）两层都在——同一台机器实测约 1MB/s，快十倍。
# 默认：两边各取同一个文件的前 3MB 实测速度（不按时区猜：用户时区是 Asia/Taipei，
# 网络却和大陆一样连不上 R2——时区说明不了网络）。MOYE_MODEL_SOURCE=ollama|modelscope 可强制。
probe_speed() {  # probe_speed <manifest-url> <blob-url-prefix> → 字节/秒（失败给 0）
  local digest
  digest="$(curl -fsS --max-time 8 -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' "$1" 2>/dev/null \
    | grep -oE '"digest": *"sha256:[0-9a-f]+"' | sed -n 2p | grep -oE 'sha256:[0-9a-f]+')" || true
  [[ -n "$digest" ]] || { print 0; return; }
  curl -sL -o /dev/null -r 0-3000000 --max-time 10 -w '%{speed_download}' "$2/$digest" 2>/dev/null | cut -d. -f1 || print 0
}
model_source() {
  if [[ -n "${MOYE_MODEL_SOURCE:-}" ]]; then print -r -- "$MOYE_MODEL_SOURCE"; return; fi
  if [[ -z "${_model_source:-}" ]]; then
    local official mirror
    official="$(probe_speed https://registry.ollama.ai/v2/library/qwen3-vl/manifests/4b https://registry.ollama.ai/v2/library/qwen3-vl/blobs)"
    mirror="$(probe_speed https://modelscope.cn/v2/Qwen/Qwen3-VL-4B-Instruct-GGUF/manifests/Q4_K_M https://modelscope.cn/v2/Qwen/Qwen3-VL-4B-Instruct-GGUF/blobs)"
    # 魔搭不比官方慢一半以上就用魔搭：只测前 3MB 抓不到官方源「开头快、后面反复断」的问题
    # （实测前 3MB 1.7MB/s，持续一小时平均约 100KB/s），海外网络上魔搭通常慢得多，会被刷掉
    (( ${mirror:-0} > 0 && ${mirror:-0} * 2 >= ${official:-0} )) && _model_source=modelscope || _model_source=ollama
    info "下载源测速：Ollama 官方 $(( ${official:-0} / 1024 ))KB/s，魔搭 $(( ${mirror:-0} / 1024 ))KB/s → 用${_model_source/modelscope/魔搭}" >&2
  fi
  print -r -- "$_model_source"
}
# 官方名 → 魔搭上的同一个模型（Q4_K_M 与官方默认量化同级）。没有镜像的原样返回
mirror_model() {
  local mirror=""
  case "$1" in
    qwen3-vl:8b-instruct) mirror=modelscope.cn/Qwen/Qwen3-VL-8B-Instruct-GGUF:Q4_K_M ;;
    qwen3-vl:4b-instruct) mirror=modelscope.cn/Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M ;;
    qwen3-vl:2b-instruct) mirror=modelscope.cn/Qwen/Qwen3-VL-2B-Instruct-GGUF:Q4_K_M ;;
  esac
  # 没有镜像（或者传进来的已经是镜像名）就不用测速了
  if [[ -n "$mirror" && "$(model_source)" == modelscope ]]; then print -r -- "$mirror"; else print -r -- "$1"; fi
}
pull_ollama_model() {
  local name; name="$(mirror_model "${1:-$(recommended_model)}")"
  step "下载视觉模型 $name"
  ollama_up || install_ollama || return 1
  # /api/pull 是流式 JSON 行；用 node 画一行进度，免得依赖 python3（没装开发者工具的 Mac 上它会弹安装框）
  curl -fsN "$OLLAMA_URL/api/pull" -d "{\"model\":\"$name\"}" | node -e '
    const rl = require("readline").createInterface({ input: process.stdin });
    let last = "", failed = "";
    rl.on("line", (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.error) { failed = m.error; return; }
      const pct = m.total ? ` ${Math.floor((m.completed || 0) / m.total * 100)}%` : "";
      const text = `${m.status}${pct}`;
      if (text !== last) { process.stdout.write(`\r  ${text.padEnd(60)}`); last = text; }
    });
    rl.on("close", () => { process.stdout.write("\n"); if (failed) { console.error("  ✗ " + failed); process.exit(1); } });
  ' || { warn "模型下载失败。"; return 1; }
  ok "模型 $name 已就绪"
}

# 把 Ollama 设成默认 AI（仅当还没配任何云端 Key），服务起来之后通过设置接口写
use_ollama_by_default() {
  local name="$1" settings
  settings="$(curl -fs --max-time 5 http://127.0.0.1:8765/api/settings)" || return 0
  if print -r -- "$settings" | grep -q '"aiConfigured":true'; then
    info "已经配置了其他 AI 服务，没有改动。要用 Ollama，在「设置 → AI 精校设置」里切换。"
  else
    curl -fs --max-time 5 -X POST http://127.0.0.1:8765/api/settings -H 'content-type: application/json' \
      -d "{\"provider\":\"ollama\",\"ollamaModel\":\"$name\",\"autoTag\":true}" >/dev/null && ok "AI 精校已设为本机 Ollama（$name）"
  fi
}

# ---------- 开机自启服务 ----------
install_services() {
  step "注册后台服务（开机自启）"
  MOYE_NODE_DIR="$node_dir" /bin/zsh "$project_dir/安装开机自启.command"
}

# ================= 执行 =================
if [[ -n "$only" ]]; then
  # 单独装一个组件：页面里的按钮走这条路，不重新构建、不重启服务
  case "$only" in
    python) ensure_python ;;
    surya) ensure_node; ensure_python; install_surya ;;
    browser) ensure_node; install_browser ;;
    libreoffice) install_libreoffice ;;
    ollama) install_ollama ;;
    ollama-model) ensure_node; pull_ollama_model "$model" ;;
    *) die "--only 只接受 python|surya|browser|libreoffice|ollama|ollama-model" ;;
  esac
  exit $?
fi

print -r -- "${c_b}墨页 · 一键安装${c_0}  ${c_dim}$project_dir${c_0}"
print
ensure_node
ensure_npm_deps
ensure_python

print
print -r -- "${c_b}可选组件${c_0}  ${c_dim}（之后也可以在页面「设置 → 环境」里一键补装）${c_0}"
[[ -z "$want_ollama" ]] && ask "装本机 AI（Ollama + 视觉模型约 $( [[ "$(recommended_model)" == *8b ]] && echo 6 || echo 3 )GB）？不用 API Key，页面图像不离开这台 Mac" y && want_ollama=yes
[[ -z "$want_surya" ]] && ask "装 Surya 本地高精度识别（扫描件/公式/表格，约 2GB，需要 Homebrew）？" n && want_surya=yes
[[ -z "$want_office" ]] && ask "装 LibreOffice 以支持 PPT / Word（约 700MB）？" n && want_office=yes

failures=()
[[ "$want_browser" == yes ]] && { install_browser || failures+=("PDF 导出浏览器"); }
[[ "$want_surya" == yes ]] && { install_surya || failures+=("Surya"); }
[[ "$want_office" == yes ]] && { install_libreoffice || failures+=("LibreOffice"); }
ollama_model=""
if [[ "$want_ollama" == yes ]]; then
  ollama_model="$(mirror_model "${model:-$(recommended_model)}")"
  { install_ollama && pull_ollama_model "$ollama_model"; } || { failures+=("Ollama"); ollama_model=""; }
fi

if [[ "$want_services" == yes ]]; then
  install_services
  [[ -n "$ollama_model" ]] && use_ollama_by_default "$ollama_model"
fi

print
if (( ${#failures} )); then
  warn "这些可选组件没装上：${(j:、:)failures}。墨页本身可以用，之后在「设置 → 环境」里重试。"
fi
print -r -- "${c_ok}${c_b}完成。${c_0} 打开 http://localhost:3000"
