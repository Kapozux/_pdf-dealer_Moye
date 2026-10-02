#!/bin/zsh
set -e

# 路径由脚本自身位置推导，不写死——否则换台机器、换个目录就跑不起来，
# 而且绝对路径里带着用户名，不适合放进公开仓库。
project_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
agent_dir="$HOME/Library/LaunchAgents"
current_uid="$(id -u)"
service_domain="gui/${current_uid}"
services=(com.kapozux.moye-ocr com.kapozux.moye-web)

cd -- "$project_dir"
mkdir -p "$project_dir/logs" "$agent_dir"

# Node 在哪：一键安装（install.sh）会传 MOYE_NODE_DIR；否则依次找项目自带的、PATH 里的、brew 的。
# 以前写死 /opt/homebrew/bin，Intel Mac 或不用 brew 装 Node 的机器上服务根本起不来。
node_dir="${MOYE_NODE_DIR:-}"
for candidate in "$project_dir/.runtime/node/bin" "$(dirname "$(command -v node 2>/dev/null || echo /x/node)")" /opt/homebrew/bin /usr/local/bin; do
  [[ -z "$node_dir" && -x "$candidate/node" && -x "$candidate/npm" ]] && node_dir="$candidate"
done
[[ -n "$node_dir" ]] || { echo "找不到 Node.js。先运行 ./install.sh"; exit 1; }
export PATH="$node_dir:$PATH"

# 重装服务会重启识别服务，而任务进度只在整份文档跑完时落盘（CLAUDE.md 第一条）。
# 有任务在跑就先问一句，别把用户正在转的书打断。
if [[ -f "$project_dir/data/moye.db" ]] && command -v sqlite3 >/dev/null 2>&1; then
  active="$(sqlite3 "$project_dir/data/moye.db" "select count(*) from jobs where status in ('queued','running')" 2>/dev/null || echo 0)"
  if [[ "$active" != "0" && -n "$active" ]]; then
    echo "有 $active 份文档正在转换或排队。重装服务会重启识别服务，正在跑的文档会从存档页续跑。"
    if [[ -z "${MOYE_YES:-}" ]] && { : </dev/tty; } 2>/dev/null; then
      read -r "answer?继续吗？[y/N] " </dev/tty
      [[ "$answer" == [yY]* ]] || { echo "已取消，服务没有动。"; exit 0; }
    else
      echo "非交互运行，为安全起见不重装服务。任务跑完后再运行：./安装开机自启.command"
      exit 0
    fi
  fi
fi

echo "正在构建墨页网页…"
npm run build

for service_name in "${services[@]}"; do
  # 仓库里存的是模板（不含绝对路径），安装时把真实路径填进去——
  # launchd 不接受相对路径，也不展开 $HOME，必须在这一步写死。
  template="$project_dir/launchd/${service_name}.plist.template"
  rendered="$(mktemp -t "${service_name}")"
  sed -e "s#__PROJECT_DIR__#${project_dir}#g" -e "s#__HOME__#${HOME}#g" -e "s#__NODE_DIR__#${node_dir}#g" "$template" > "$rendered"
  target_plist="$agent_dir/${service_name}.plist"
  plutil -lint "$rendered"
  /usr/bin/install -m 644 "$rendered" "$target_plist"
  rm -f "$rendered"
  launchctl bootout "$service_domain/$service_name" 2>/dev/null || true
done

# launchd 偶尔需要一点时间释放刚退出的 KeepAlive 任务；等待后重试，避免错误 5。
sleep 1
for service_name in "${services[@]}"; do
  target_plist="$agent_dir/${service_name}.plist"
  loaded="false"
  for retry_number in {1..5}; do
    if launchctl bootstrap "$service_domain" "$target_plist" 2>/dev/null; then
      loaded="true"
      break
    fi
    sleep 1
  done
  if [[ "$loaded" != "true" ]]; then
    echo "无法注册服务：$service_name"
    exit 1
  fi
  launchctl enable "$service_domain/$service_name"
done

echo "已安装开机自启，正在等待服务就绪…"
for attempt_number in {1..40}; do
  moye_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)"
  ocr_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/health || true)"
  if [[ "$moye_code" == "200" && "$ocr_code" == "200" ]]; then
    echo "墨页网页和识别服务均已就绪。"
    open "http://localhost:3000/"
    exit 0
  fi
  sleep 1
done

echo "服务尚未全部就绪，请查看：$project_dir/logs"
exit 1
