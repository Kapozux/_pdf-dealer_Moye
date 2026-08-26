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
- `server/convert.mjs` 的 `aiGate` 是**全局**闸，限制「此刻打向模型的请求总数」。
  job 级并发只是喂料口，真正的天花板是 aiGate。
- 三层兜底：**换供应商** → **换模型** → **回退 PDF 文字层**

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
local-ocr-server.mjs   8765 服务入口：HTTP 路由、四家供应商调用、settings.local.json 读写
server/queue.mjs       按模式（fast/balanced/math/ai）分车道限流 + 协作式取消 + SSE 广播
server/convert.mjs     转换管线本体：文字层排版还原、Surya HTML→MD、AI 校验/回退、aiGate/renderGate 两个闸
server/pacer.mjs       AI 模式的自适应节流器（AIMD，按渠道独立车道），local-ocr-server 用它派活
server/jobstore.mjs    SQLite 任务表 + 磁盘布局 + 重启恢复 + 逐页 checkpoint（pages.jsonl）
server/render.mjs      spawn Python(pypdfium2) 把 PDF 页转 JPEG，供 AI 模式用
server/zip.mjs         手写最小 ZIP 打包器，只为 Library 整包下载存在
lib/ai-settings.ts     AI 设置的类型 + 浏览器→8765 的设置类 API 客户端
lib/api.ts             浏览器→8765 的任务类 API 客户端（提交/查询/SSE 订阅/Library/导出）
lib/pdf-to-markdown.ts 只剩前后端共用的类型定义；真正实现已搬到 server/convert.mjs
app/page.tsx           前端几乎全部逻辑（1100+ 行单文件）：拖拽/批量、进度订阅、Library、结果四个 tab、设置弹窗
worker/index.ts        3000 服务的 vinext/Cloudflare 适配层，顺带处理 HTML 不缓存（否则旧 JS chunk 会残留，见上面第二条规则）
```

改动前先按这张表定位文件，不要凭猜测改错地方——比如"AI 结果为什么没校验公式"要看 `convert.mjs` 的 `validateAiPage`，不是 `local-ocr-server.mjs`。

### 启动脚本的关系

`启动全部服务.command`（=`start.command` 转发）→ 没装过 launchd 服务就转去跑 `安装开机自启.command`（build + 注册两个 launchd agent），装过了就 `launchctl kickstart` 两个服务再等 `/health` 就绪。真实路径在安装时才写进 `~/Library/LaunchAgents/*.plist`（`launchd/*.plist.template` 里的 `__PROJECT_DIR__`/`__HOME__` 占位符），仓库里存的模板不含绝对路径。

用户另有一个独立项目 `~/Documents/CODEelse/getAudio`，启动方式（`launchctl` 常驻 + 自己的 `启动服务.command`）是同一套约定的来源（本文件顶部"参考 GetAudio"说的就是这个），但两者服务完全独立，互不依赖、互不共享端口。`logs/` 目录里的 `getaudio.err.log`/`getaudio.out.log` 是历史遗留的普通文件（不是软链接，2026-08-17 的，比本项目自己的 launchd 服务还早一天），跟当前两个服务无关，可以忽略。

### 测试是字符串断言网，不是行为测试

`tests/rendered-html.test.mjs` 主要靠 `assert.match` 抓文件里的关键字符串（函数名、UI 文案、依赖名）存在与否，用来防止"某个功能被顺手删掉"。改 UI 文案、重命名导出函数、换掉某个 provider 的固定字符串，都可能让它不相关地挂掉——挂了先看是真的少了功能，还是只是字符串对不上了。

### 几处脚手架遗留（vinext/OpenAI sites 模板带出来的，非本项目功能）

- `app/chatgpt-auth.ts` —— ChatGPT 登录集成，全项目没有任何地方 import 它。
- `app/_sites-preview/` —— 空目录。
- `vite.config.ts` 里的 D1/R2 绑定（`site-creator-d1`/`site-creator-r2`）—— 用的是占位 database id，本文件也写着"墨页本身跑在本机，不使用 D1/R2"。

没在功能上生效，暂时留着没有坏处；确认要清理时先 grep 一遍确认没有隐藏引用。

---

## 四、密钥与隐私

- 密钥只存 `settings.local.json`（`0600`，已 gitignore）。**永远不要打印明文、不要提交、不要外传。**
- 服务端只回传**打码**版本给页面。
- 改密钥相关逻辑时注意：页面拿不到明文，回传时用 `__KEEP__` 占位表示「保持原样」。
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
npm test           # build + 渲染测试
npm run lint

launchctl kickstart -k gui/$(id -u)/com.kapozux.moye-ocr   # 重启识别服务
launchctl kickstart -k gui/$(id -u)/com.kapozux.moye-web   # 重启网页服务
./启动全部服务.command                                       # 两个一起
```

环境变量（都有实测依据，改前先读代码注释）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `MOYE_AI_JOB_CONCURRENCY` | 48 | 同时跑几份文档（喂料口，非上限） |
| `MOYE_AI_PAGE_CONCURRENCY` | 按渠道权重 | 覆盖全局 aiGate 上限 |
| `MOYE_PAGE_TIMEOUT_MS` | 30000 | 单次模型调用超时（实测 p50 约 13s） |
| `MOYE_RESCUE_TIMEOUT_MS` | 25000 | 补救轮超时（只试一次） |
| `MOYE_OPENROUTER_PROVIDERS` | CoreWeave,Parasail,Inceptron,Baidu,Cloudflare | 供应商白名单 |
| `MOYE_OPENROUTER_FALLBACK_MODELS` | z-ai/glm-5v-turbo,qwen/qwen3.7-flash | 模型兜底链 |
| `MOYE_RENDER_CONCURRENCY` | 16 | 同时几个 Python 渲染进程 |
