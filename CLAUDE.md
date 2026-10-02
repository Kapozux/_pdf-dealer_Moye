# 墨页 · 给 AI 助手的工作约束

这份文件是给 Claude / AI 助手看的。**动手前先读完**。

本项目是本机运行的 PDF→Markdown 工具，用户是它的日常使用者，
经常**正在用它处理真实作业**。任何操作都可能打断真实工作。

---

## 一、硬性规则（违反过，代价很大）

### 1. 不要随便重启服务

`server/queue.mjs` 的任务进度**只在整份文档跑完时才落盘**。
中途重启 = 所有在跑的文档从头再来。

> 2026-08-18 实测教训：一批 15 份 537 页的任务，因为 4 次重启白跑了 800+ 页，
> 比整批还多，35 分钟没跑完。用户当时急着要文件。

**规则**：
- 重启前先查 `sqlite3 data/moye.db "select count(*) from jobs where status in ('queued','running')"`
- 有任务在跑 → **先问用户**，不要自作主张
- 已实现逐页存档（`data/jobs/<id>/pages.jsonl`），重启会续跑；但仍要确认

### 2. `npm run build` 之后必须重启网页服务

构建会换掉 `dist/` 里 JS chunk 的哈希文件名并删除旧的，
而已启动的 `vinext start` 还在按旧名字发页面 → **JS 404 → 页面全白 → Library 看起来是空的**。

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.kapozux.moye-web
```

验证（每个 chunk 都必须 200）：
```bash
for u in $(curl -s http://localhost:3000/ | grep -oE '/_next/static/chunks/[^"]+\.js' | sort -u); do
  echo "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000$u) $u"; done
```

### 2b. 打标签现在一并生成 AI 标题

`generateCardMeta`（原 `generateTags`）一次返回 `tags + ai_title + ai_one_line + filename_meaningful`，写进 jobs 表的三个新列（`jobstore.mjs` 里 ALTER 加的）。「补标签」按钮会把没标签**或**没标题的老记录都补一遍。回顾栏目的叙事靠 `ai_title/ai_one_line` 写，标题没补全时叙事只能看文件名，质量会差。

### 3. 「Library 空了」几乎都不是数据丢失

先查，别慌，更别去动数据：
```bash
sqlite3 data/moye.db "select count(*) from jobs where status='done'"
curl -s http://127.0.0.1:8765/api/library | head -c 200
```
真实数据在 SQLite + `data/jobs/<id>/`。历史上两次「Library 没了」都是
前端问题（chunk 不一致 / 页面在服务重启窗口里加载失败），刷新即可。

### 4. 绝不静默吞掉错误

`refineOne` 曾经把 AI 失败全部转成「回退文字层」而不打日志，
导致排查时只能靠猜，反复得出错误结论。**任何失败路径都要留下原因。**

---

## 二、性能调优的纪律

这个项目的性能参数**全部是实测出来的**，不是推理出来的。
改任何并发/超时数字前，先读代码里的实测注释。

### 已知会导致错误结论的陷阱

| 陷阱 | 后果 |
|---|---|
| **用 `lsof` 数 TCP 连接来估「在途请求数」** | 严重低估（连接复用）。用 `/api/debug` 看 `aiGate.inFlight` |
| **连续压测不留冷却** | 前一轮的余波污染下一轮，得出「并发一高就崩」的假结论 |
| **拿突发压测的数字当持续负载的上限** | 突发 64 路全过，持续跑几十分钟同样 64 路大面积超时 |
| **Bash 默认 2 分钟超时** | 压测被掐死，却被误读成「上游失败」。长任务用 `run_in_background` |
| **单次测量就下结论** | 上游吞吐本身波动 3 倍（同样 64 路，1.15～3.38 页/秒） |

> 我在这些坑里把 OpenRouter 权重改了三次（64→4→32→64），全是错的。
> 真因是**没指定底层供应商**，OpenRouter 把请求全灌给一家会挂死的供应商。

### 诊断入口

**先看这个，不要去数连接：**
```bash
curl -s http://127.0.0.1:8765/api/debug | python3 -m json.tool
```
给出 `aiGate`（limit/inFlight/waiting）、`renderGate`、各渠道权重、
OpenRouter 模型健康度、每份在跑任务的阶段。

日志：
```bash
grep '\[AI失败\]\|\[换供应商\]\|\[换模型\]\|\[模型熔断\]\|\[补救\]' logs/moye-ocr.err.log
```

---

## 三、架构要点

```
浏览器(3000)  ──提交/看进度──▶  本机服务(8765)  ──▶  Surya / 视觉模型
   纯前端                        队列·转换·存储
```

- **浏览器只是观察者**，转换全在服务端。关页面任务照跑。
- `server/queue.mjs` 按模式限流：fast 4 / balanced 1 / math 1 / ai 48
- **取消是真的**：队列给每个任务一个 token，convert.mjs 每领一页之前看一眼，取消后只把在途的几页跑完（`JobCancelled`）。重新精校被取消时记录退回 done、旧结果原样保留（`_settleCancelled`），不会从 Library 消失
- `server/convert.mjs` 的 `aiGate` 是**全局**闸，限制「此刻打向模型的请求总数」。
  job 级并发只是喂料口，真正的天花板是 aiGate。
- 三层兜底：**换供应商** → **换模型** → **回退 PDF 文字层**
- **本机 Ollama 是第五家 provider**（`callOllama`，local-ocr-server.mjs）：没有 Key，「已配置」= 选了模型（`ollamaModel`）。走 Ollama 原生 `/api/chat` 而不是 `/v1` 兼容层——兼容层设不了 `num_ctx`，Ollama 默认上下文只有几千 token，图像 + 提示 + 初稿会被**静默截断**。模型能力（vision / thinking）问 `/api/show` 并缓存：不带 vision 的直接报错；**带 thinking 的也直接拒绝**——2026-09-24 实测（Ollama 0.34.3），官方 `qwen3-vl:8b` 就是思考版，`think:false` + JSON Schema 时回答被写进 `message.thinking`、正文为空且只有半截，不给格式时 `think:false` 被无视、先想 1.4 万字；换 Instruct 版（`qwen3-vl:8b-instruct` / 魔搭 `Qwen3-VL-8B-Instruct-GGUF`）同一页一次出合法 JSON。所以推荐和镜像表里全是 `-instruct`，别改回不带后缀的标签。并发 1、单次超时 180s、补救轮也用 180s（云端那套 25s 补救在本机必败）、初稿截到 6000 字、num_ctx 16384。2026-09-24 第一次实测（48GB Mac、魔搭 Qwen3-VL-8B-Instruct Q4_K_M、4 页 IB 物理作业）：正常页 5～15s、输出 200～500 token，首页另加约 20s 冷启动加载模型——180s 超时和 6144 的 num_predict 都宽得很，但样本只有一份，没据此收紧。**会陷入死循环**：温度 0 时某页在 JSON 字符串里无限输出 `\n` 写满上限（约 100s），所以撞上限时当场换 `presence_penalty 1.5` 重试一次；**别用 `repeat_penalty`**，它会让模型把 JSON 里的 `\\frac` 写成 `\frac`，公式直接坏掉（详见 `callOllama` 里的注释）。费用记 0（不是 null，否则界面显示「未计价」）。页面图像不出本机，顶栏隐私标签和模式说明靠 `aiStaysLocal`（lib/ai-settings.ts）判断
- Python 环境位置：`MOYE_VENV` → 仓库里的 `.venv`（一键安装建的）→ 老的 `../.venv-marker`，按顺序找第一个有 `bin/python` 的
- **「重新精校」可以只重跑回退页**：结果页的「只重跑 N 页回退页」按钮 → `POST /api/library/<id>/refine` 带 `{only:"fallback"}`
  → 选项写在 `data/jobs/<id>/refine.json`（不塞进 previous.json，因为失败时 previous 会原样存回去）
  → `refineExisting` 把上次成功的 AI 页作为 `keep` 交给 `refineWithAi`，走的就是逐页存档那条「已完成页直接用」的路径。
  「回退页」的唯一定义是 `lib/page-result.mjs` 的 `outcome()`（`isFallback` 由它派生；convert / jobstore / 精校路由 / page.tsx 都 import 这一份，没有镜像了）：`aiAttempted && method !== "ai"`，noText 算成功不算回退。
  加它是因为 912 页的书有 409 页因上游超时回退，整份重跑要把 503 页好的也再花一遍钱。
- **「模型返回空白」不等于失败**：模型可以回 `noText: true` + `note`（例：a photo of a cat），
  表示这页/这张图本来就没有可提取的文字。这条路径在 `normalizeAiResult`（local-ocr-server.mjs）
  放行、`validateAiPage`（convert.mjs）跳过校验、`refineOne` 标成 `noText` 页并写进「需复核」清单。
  加它是因为图片支持上线后，一张风景照会被记成「AI 识别失败，已回退文字层」——查不出真实原因，
  正是第四条规矩要防的事。

### AI 模式为什么是「逐页转图」而不是直传 PDF

实测（Gemini，同一份 4 页 PDF）：

| | 逐页图 | 直传 PDF |
|---|---|---|
| 墙钟 | **14.1s** | 29.5s |
| 上传 | 549KB | 210KB |
| token | 1132 | 1079 |
| 产出 | **2142 字符** | 1818 字符 |

逐页可以并行，打包只能串行生成。渲染开销可忽略（4 页 137ms）。
**结论：不要改成直传 PDF。** 另外逐页才能做逐页校验和回退。

### 代码地图（谁管什么，改之前先找对文件）

```
local-ocr-server.mjs   8765 服务入口：HTTP 路由、五家供应商调用（settings.local.json 的读写已搬到 server/settings.mjs）
server/queue.mjs       按模式（fast/balanced/math/ai）分车道限流 + 协作式取消 + SSE 广播
server/convert.mjs     转换管线本体：文字层排版还原、Surya HTML→MD、AI 校验/回退、aiGate/renderGate 两个闸
server/pacer.mjs       AI 模式的自适应节流器（AIMD，按渠道独立车道），local-ocr-server 用它派活
server/jobstore.mjs    SQLite 任务表 + 磁盘布局 + 重启恢复 + 逐页 checkpoint（pages.jsonl）
server/render.mjs      spawn Python(pypdfium2) 把 PDF 页转 JPEG，供 AI 模式用；convert.mjs 按 48 页一组滚动调用它，不是一次渲染整本
server/textlayer-worker.mjs  读 PDF 文字层的短命子进程（pdfjs 解析大书要 3GB 且释放不掉，放子进程里跑完即退，服务本体不背）
server/image2pdf.mjs   图片（png/jpg/webp/bmp/tiff/gif/heic）→ PDF：用 Surya venv 里的 Pillow，按 resolution=144 存，页面尺寸正好是像素的一半，配 render.mjs 的 scale=2 回渲即原始像素（实测无损）；HEIC 走 macOS sips；长边超 4000px 缩到 4000
server/usage.mjs       模型用量与费用记账（data/usage.db，独立于 moye.db）：四条 provider 路径（callGemini / callOpenAiCompatible / callTextModel 两支）拿到响应体先记一笔再解析。归属（ref=任务 id、purpose=refine/card/reflect/test）靠 AsyncLocalStorage 的 `usage.scope` 从队列 run / generateCardMeta / generateReflectText / 测试连接 入口传下来，中间层不用改签名。费用两种来源：OpenRouter 响应带 `usage.cost`（请求要带 `usage:{include:true}`）照抄；Gemini 按内置价格表算，`data/prices.json` 可覆盖、30 秒热重读；查不到价的模型（直连 Kimi / Qwen）只记 token、界面标「未计价」，**不要瞎猜价格**。任务跑完 `jobStore.setCost` 把合计抄进 jobs 表（cost_usd 等列），结果页和 Library 只读那几列；面板「用量」栏读 `/api/usage`。逐页 `usage` 字段是顺手带回结果里的，完整账以 usage.db 为准
server/reflect.mjs     「回顾」栏目：按时段算统计（转换最多的星期/时段、按日曲线、按页数的主题占比）+ 让模型写叙事（OpenRouter 上的 Claude Opus 4.6，没 key 回落当前服务商），中英并行生成、缓存在 data/reflect-cache.json。叙事是**提前算好**的：启动 90s 后首跑、每 6h 检查、每次转换完成 10 分钟防抖后重算；打开面板缓存过期就先给旧的（stale=true）并后台重算，前端每 6s 轮询。只有点刷新才同步等
server/setup.mjs       「设置 → 环境」：检测各组件（Python 环境 / Surya+llama-server / LibreOffice / 自带浏览器 / Ollama 及其视觉模型 / AI 服务）装没装，页面按钮一键补装。**安装逻辑只在 install.sh 一份**，这里 spawn `install.sh --only <组件> --yes`、把输出收成最后 40 行给页面、同时写 logs/setup.log；只有 Ollama 拉模型直接读 `/api/pull` 的流（要字节级进度条）。拉完模型：还没选过 Ollama 模型就填上；一个 AI 都没配就直接把 provider 设成 ollama——已在用云端的不改 provider。
                       **模型下载源**：Ollama 官方库的文件在 Cloudflare R2 上，2026-09-24 在用户网络上实测约 100KB/s、分块反复 EOF 后 `max retries exceeded` 放弃（走系统代理也没用——Ollama 不读 macOS 系统代理；用户时区是 Asia/Taipei，按时区猜也不准）。魔搭有同一模型的 Ollama 格式（`modelscope.cn/Qwen/Qwen3-VL-8B-Instruct-GGUF:Q4_K_M`，本体 + 视觉投影两层），同机约 1MB/s。所以两边各取前 3MB 实测速度选源（`probeSpeed` / install.sh 的 `probe_speed`），镜像表 `OLLAMA_MIRRORS` 与 install.sh 的 `mirror_model` 是同一张，改一边要改另一边
install.sh             一键安装（`一键安装.command` 双击转发、`curl … | zsh` 远程也是它）：Node（找不到 ≥22.13 就从 nodejs.org 下到 .runtime/node，校验 SHASUMS256）、npm 依赖、uv（UV_UNMANAGED_INSTALL 装进 .runtime/uv，不改 shell 配置）、Python 3.12 venv（.venv，带 pypdfium2+Pillow），可选 Ollama（下 Ollama-darwin.zip 到 /Applications 或 ~/Applications）+ 按内存推荐的视觉模型、Surya（**还要 llama.cpp 的 llama-server**，只能 brew 装，没 brew 就明说）、LibreOffice（brew 或给下载链接）、自带浏览器，最后调 `安装开机自启.command`。可重复跑，装过的跳过；非交互时按默认值、不提问。`uninstall.sh` 撤开机自启
server/filenames.mjs   源文件名 → 标题的唯一一份扩展名正则（队列标题、自动标签、ZIP 条目名共用，以前各写一份，加 Word 时漏掉 ZIP 那份）
server/zip.mjs         手写最小 ZIP 打包器，只为 Library 整包下载存在
server/images2pdf.mjs  很多图片 → 一份成品 PDF（反方向的旁路，跟 md2pdf 同一类：不进队列、不进 Library、不识别）。**和上面的 image2pdf.mjs 是两条路，别改错**：那条是为了喂识别管线（resolution=144、长边压到 4000px），这条的 PDF 本身就是交付物，所以一个像素都不缩，JPEG/PNG 原字节用 pdf-lib 直接 embed——Pillow 存 PDF 会把每张重新编码成 JPEG，成品会比原图糊一档；只有 webp/heic/tiff/bmp/gif、多帧、带 EXIF 旋转的才过一道 Pillow 转 JPEG(q95)/PNG，HEIC 照旧先走 sips。页面尺寸不影响存进去的像素（PDF 里是矢量坐标），按「图片自身比例、长边 = A4 长边 842pt」排版，每页被填满无白边，比原图小的不放大。上传分两步（`POST /api/images2pdf/part` 逐张流式落到 `tmp/images2pdf/<session>/`，`POST /api/images2pdf/build` 按页序合成后回 PDF 并删暂存，另有 2 小时的残留扫除），是为了不把几十张照片一次性堆进内存；坏图逐张跳过、原因走 `X-Moye-Skipped` 响应头回到页面（规矩四：不静默吞错误）
server/md2pdf.mjs      Markdown → PDF（反方向）：marked + KaTeX 渲染成 HTML，再用**自带的** chrome-headless-shell 无头打印（DevTools 协议 Page.printToPDF；`npm run browser:install` 下到 `data/browser/`，独立程序 + 独立 profile，和用户的 Chrome 无关——2026-09-14 直接调 /Applications 里的 Chrome 时把用户正开着的 Chrome 关掉过一次，原因没查清，**测试时也绝不要再启动用户的 Chrome**）。没装自带浏览器才兜底用系统 Chrome，日志 `[PDF]` 会提醒。入口两个：结果页「下载 PDF」（GET /api/library/<id>/document.pdf）和首页拖入 .md（POST /api/md2pdf）。不进队列不进 Library。**不要传 --user-data-dir**：全新 profile 实测要等 60～113s，不传 2s。**不要用 `--print-to-pdf` 命令行开关**：它退出时有竞态，大 PDF 没写完就 SIGTRAP 崩（912 页的书 3/3 必崩），现在走 `--remote-debugging-pipe` + `Page.printToPDF` 流式取回。单次打印超过约 150 页 Chrome 渲染进程也会偶发崩，所以大文档按标题切段（`splitMarkdownForPrint`，默认 300KB 一段）分别打印、失败重试、再用 pdf-lib 合并，日志标签 `[PDF重试]`。版面逐条对照 obsidian.asar 里的 app.css 抄的（用户要「和 Obsidian 导出 PDF 一样」；2026-09-14 核对过：导出字体是 **Arial**、正文纯黑、Letter + 1cm 边距 + 32px 内边距、文件名印成第一个 h1、标题上下只有 1rem、链接带下划线、自绘圆点和勾选框、提示框带 lucide 图标——细节见 PRINT_CSS 的注释），语法也按 Obsidian：单换行即换行、`> [!note]` 提示框、`==高亮==`、`[[双链]]`、去掉 YAML 属性区——只在 PDF 这条路，页面「渲染」tab 不受影响
lib/ai-settings.ts     AI 设置的类型 + 浏览器→8765 的设置类 API 客户端（局部保存用 patchAiSettings，只发改动的字段）
lib/page-result.mjs    「一页最后算什么」的唯一定义：outcome()（ai / noText / fallback / local）、四种 AI 结果的构造、重跑用的 toDraft（白名单取字段）、页面度量。前后端共用，所以是 .mjs + JSDoc
lib/key-pool.mjs       额外 Gemini Key 列表的页面↔服务端协议，两半写在一起：页面 rowsFromSaved / rowsToPayload，服务端 mergeExtraKeys。占位符带出处 `__KEEP__:<位置>:<末4位>`
server/settings.mjs    settings.local.json 的 load / save（部分保存：没传的字段沿用；多处同时保存会排队）、normalizeSettings、providerConfigured（「这家能用了吗」的唯一判断）
server/request-guard.mjs  8765 只接本机请求：Host 必须是 127.0.0.1/localhost/[::1]:8765（防 DNS rebinding），带 Origin 的必须是本机页面（任意端口，Moye 3000、Verbatim 5001）；不带 Origin 的本机程序（curl、install.sh、Verbatim 的 sources.py）照常放行。加它是因为任意网页都能对本机发不预检的 POST——改 AI 服务地址就能让之后每次转换把 Key 发出去。新加调用方时用 127.0.0.1:8765
lib/explain-error.mjs  报错 → 类别（额度 / Key / 限流 / 超时 / 连不上 / 模型 / 拦截 / 输出坏 / 没过校验 / 空文件）+ 重跑有没有用。规则按库里真实报错定（2026-10-02 全库 1184 页回退页全部归得了类）；Gemini 额度用完回的是 429，所以「额度」排在「限流」前。文案在 page.tsx 的 errorCopy（走 i18n）；报错原文从 reasons 里读回用 page-result.mjs 的 parseAiReason / fallbackCause
lib/safe-url.mjs       Markdown 里链接 / 图片地址的白名单（javascript: 之类只留文字，外链图片不自动加载）；页面的 renderMarkdown 用 safeLinkRenderers。md2pdf.mjs 那份渲染还没接上
                       结果页「逐页核对」：左原图（GET /api/library/<id>/page/<n>.jpg，服务端用 pypdfium2 现渲染一页、最近 40 页缓存在内存）、右这一页的结果；地址 #/doc/<id>/p/<n> 可直接分享到某一页，同一份文档里前进后退不重新拉结果
lib/api.ts             浏览器→8765 的任务类 API 客户端（提交/查询/SSE 订阅/Library/导出）
lib/pdf-to-markdown.ts 只剩前后端共用的类型定义；真正实现已搬到 server/convert.mjs
app/page.tsx           前端几乎全部逻辑（2000+ 行单文件）：拖拽/批量、进度订阅、Library、结果四个 tab、统一面板（左侧栏目：回顾 / 资料库 / 用量 / AI 精校设置 / 环境 / 关于，`openPanel(pane)` 打开；原来的设置弹窗和左下角统计浮层都并进来了）
                       待转区只要有图片就多一个「合成一份 PDF」按钮（`mergeStagedImages`）：按文件名自然序（Intl.Collator numeric，IMG_2 排在 IMG_10 前）排页，不进队列直接下载；结果提示复用 `mdNote` 那一行
                       下载文件名规则在 `docDownloadName`：「名字 转换日期.md」，原文件名像标题（打标签时 AI 判的 `filename_meaningful`）就用原名，否则用 `ai_title`
                       预计剩余时间：`/api/speed` 按模式给最近 50 份的每页秒数中位数（jobs.duration_ms ÷ page_count，转换墙钟不含排队；样本少于 3 份不给数）；进度页跑到 ≥3 页且 ≥10%、20 秒以上后改用本份的实时速度。模式选择处的「约 X 秒/页」也是它，没数据才用写死的文案
                       完成提醒：提交任务时申请 Notification 权限；跑完时页面不可见发系统通知、可见弹 2 秒 toast（`announceDone`）。Esc / 点背景关面板
worker/index.ts        3000 服务的 vinext/Cloudflare 适配层，顺带处理 HTML 不缓存（否则旧 JS chunk 会残留，见上面第二条规则）
```

改动前先按这张表定位文件，不要凭猜测改错地方——比如"AI 结果为什么没校验公式"要看 `convert.mjs` 的 `validateAiPage`，不是 `local-ocr-server.mjs`。

### 启动脚本的关系

`启动全部服务.command`（=`start.command` 转发）→ 没装过 launchd 服务就转去跑 `安装开机自启.command`（build + 注册两个 launchd agent），装过了就 `launchctl kickstart` 两个服务再等 `/health` 就绪。真实路径在安装时才写进 `~/Library/LaunchAgents/*.plist`（`launchd/*.plist.template` 里的 `__PROJECT_DIR__`/`__HOME__` 占位符），仓库里存的模板不含绝对路径。

用户另有一个独立项目 `~/Documents/CODEelse/getAudio`，启动方式（`launchctl` 常驻 + 自己的 `启动服务.command`）是同一套约定的来源（本文件顶部"参考 GetAudio"说的就是这个），但两者服务完全独立，互不依赖、互不共享端口。`logs/` 目录里的 `getaudio.err.log`/`getaudio.out.log` 是历史遗留的普通文件（不是软链接，2026-08-17 的，比本项目自己的 launchd 服务还早一天），跟当前两个服务无关，可以忽略。

### 两套测试：行为测试在长，字符串断言网在缩

- `npm run test:unit`（`tests/behaviour/`）：经模块接口测行为，**不用 build、不碰服务**，一秒内跑完。改页结果 / 设置 / Key 合并相关的代码，先跑它。
- `tests/rendered-html.test.mjs`：主要靠 `assert.match` 抓文件里的关键字符串（函数名、UI 文案、依赖名）存在与否，用来防止"某个功能被顺手删掉"。改 UI 文案、重命名导出函数、把代码搬到别的文件，都可能让它不相关地挂掉——挂了先看是真的少了功能，还是只是字符串对不上了。某条断言的行为有了行为测试，就删掉那条断言（替换，不叠加）。

### 几处脚手架遗留（vinext/OpenAI sites 模板带出来的，非本项目功能）

- `app/chatgpt-auth.ts` —— ChatGPT 登录集成，全项目没有任何地方 import 它。
- `app/_sites-preview/` —— 空目录。
- `vite.config.ts` 里的 D1/R2 绑定（`site-creator-d1`/`site-creator-r2`）—— 用的是占位 database id，本文件也写着"墨页本身跑在本机，不使用 D1/R2"。

没在功能上生效，暂时留着没有坏处；确认要清理时先 grep 一遍确认没有隐藏引用。

---

## 四、密钥与隐私

- 密钥只存 `settings.local.json`（`0600`，已 gitignore）。**永远不要打印明文、不要提交、不要外传。**
- 服务端只回传**打码**版本给页面。
- 改密钥相关逻辑时注意：页面拿不到明文，回传时用占位符表示「保持原样」（协议在 `lib/key-pool.mjs`，带出处，不按位置配；行为测试在 `tests/behaviour/settings.test.mjs`）。
  > 曾经因为「页面看不到已存的 key」导致用户以为没存上、重新添加、
  > 把旧 key 静默覆盖。改这块务必保证**看得见 + 不会误覆盖**。

---

## 五、与用户协作

- **用户经常在赶时间。** 先给可用的东西，再讲分析。
- 结果文件随时可直接导出，不必等 UI：
  ```bash
  # 已完成的 markdown 就在 data/jobs/<id>/document.md
  sqlite3 data/moye.db "select id,filename from jobs where status='done'"
  ```
- 不确定就说不确定。**推翻自己的结论要明说**，不要悄悄改口。
- 别用长篇分析淹没结论。用户要的是「好了没」「还要多久」「文件在哪」。

---

## 六、常用命令

```bash
npm run dev        # 开发（注意别和后台的 3000 端口服务打架）
npm run build      # 构建（之后必须重启网页服务）
npm run test:unit  # 行为测试：不 build、不碰服务，改完先跑这个
npm test           # build + 渲染测试（会换掉 dist/，之后必须重启网页服务）
npm run lint

launchctl kickstart -k gui/$(id -u)/com.kapozux.moye-ocr   # 重启识别服务
launchctl kickstart -k gui/$(id -u)/com.kapozux.moye-web   # 重启网页服务
./启动全部服务.command                                       # 两个一起
```

环境变量（都有实测依据，改前先读代码注释）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `MOYE_AI_JOB_CONCURRENCY` | 1（2026-08-18 起，原为 48） | 同时跑几份文档（喂料口，非上限）。默认改回 1 是实测结论：全局并发预算（aiGate，约 60 路）是所有文档共享的，开太多份文档只会把预算摊薄，谁都吃不满、谁都不交付；一份文档独占预算跑完最快。只有「一次转很多小文档（每份一两页）」时才该调大，调到「预算 ÷ 平均页数」左右——见 `server/queue.mjs` 里这行的注释 |
| `MOYE_AI_PAGE_CONCURRENCY` | 按渠道权重 | 覆盖全局 aiGate 上限 |
| `MOYE_PAGE_TIMEOUT_MS` | 30000 | 单次模型调用超时（实测 p50 约 13s） |
| `MOYE_RESCUE_TIMEOUT_MS` | 25000 | 补救轮超时（只试一次） |
| `MOYE_OPENROUTER_PROVIDERS` | CoreWeave,Parasail,Inceptron,Baidu,Cloudflare | 供应商白名单 |
| `MOYE_OPENROUTER_FALLBACK_MODELS` | z-ai/glm-5v-turbo | 模型兜底链。曾经还带 qwen/qwen3.7-flash，2026-08-25 起白名单五家对它全部返回 404（没有供应商在提供了），摘掉了 |
| `MOYE_RENDER_CONCURRENCY` | 16 | 同时几个 Python 渲染进程 |
| `MOYE_RENDER_CHUNK_PAGES` | 48 | AI 模式一次渲染几页。2026-08-29 实测：698 页整本一次渲染 = 350MB base64 走 stdout，120s 必超时；分组后单次约 2s / 25MB，内存上限从整本变成约两组，服务进程峰值 3.9GB → 0.8GB |
| `MOYE_TEXTLAYER_TIMEOUT_MS` | 900000 | 读文字层子进程的超时（698 页实测 20s，给足 15 分钟） |
| `MOYE_IMAGEBOOK_TIMEOUT_MS` | 300000 | 「很多图片 → 一份 PDF」里单次 Pillow / sips 调用的超时 |
| `MOYE_VENV` | `.venv`，没有就 `../.venv-marker` | Python 环境（pypdfium2 / Pillow / 可选 Surya） |
| `MOYE_OLLAMA_CONCURRENCY` | 1 | 本机 Ollama 同时几页。Ollama 默认一个模型只并行 1 路（OLLAMA_NUM_PARALLEL），调大它之后再跟着调这个 |
| `MOYE_TIMEOUT_OLLAMA` | 180000 | 本机 Ollama 单次调用超时（实测正常页 5～15s，只测过一份 4 页文档） |
| `MOYE_OLLAMA_NUM_CTX` | 16384 | 上下文长度。8B 模型约多占 2.4GB 内存；调小会截断提示词 |
| `MOYE_OLLAMA_DRAFT_CHARS` | 6000 | 文字层初稿最多带多少字给本机模型（云端是 60000） |
| `MOYE_OLLAMA_NUM_PREDICT` | 6144 | 单页最多输出多少 token；到顶会报「被截断」而不是解析失败 |
| `MOYE_CHROME` | `data/browser/` 里自带的 chrome-headless-shell，没有才找 /Applications 里的 Chrome/Chromium/Edge/Brave | Markdown → PDF 用的浏览器路径 |
| `MOYE_PDF_CONCURRENCY` | 2 | 同时几个 Chrome 打印进程（一个几百 MB） |
| `MOYE_PDF_TIMEOUT_MS` | 90000 | 单次 Chrome 打印超时 |
| `MOYE_PDF_CHUNK_BYTES` | 300000 | Markdown 超过这个大小就分段打印再合并（约 75 页一段；实测一次打 300 页只有一半成功） |
