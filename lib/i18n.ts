/**
 * 界面语言。中文原文就是 key：`t("逐页质量")` 在中文模式原样返回，英文模式查表；
 * 表里没有的原样返回（宁可露出中文也不要露出 key 或空白）。
 *
 * 为什么用模块级变量而不是 React Context：page.tsx 是一个 1500 行的单组件，
 * 所有 t() 都在它的渲染或事件里被调用；组件在每次渲染开头把当前语言写进来，
 * 比给每个子函数穿 context 省事得多，而且不需要改任何调用点的签名。
 */

export type Lang = "zh" | "en";

const STORAGE_KEY = "moye_lang";
let activeLang: Lang = "zh";

export function setActiveLang(lang: Lang) {
  activeLang = lang;
}
export function getActiveLang(): Lang {
  return activeLang;
}

export function readStoredLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
    // 没存过就看浏览器语言：中文环境默认中文，其余默认英文
    return /^zh/i.test(navigator.language || "") ? "zh" : "en";
  } catch {
    return "zh";
  }
}
export function storeLang(lang: Lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 私密窗口等情况下存不了就算了 */
  }
}

/** 界面文案：中文 key → 英文。key 里的 {name} 是插值占位。 */
export const en: Record<string, string> = {
  // ---- 通用 ----
  "墨": "M",
  "墨页": "Moye",
  "PDF/PPT 转 Markdown": "PDF/PPT → Markdown",
  "主导航": "Main navigation",
  "回到首页": "Back to home",
  "查看进度": "View progress",
  "进行中": "Running",
  "⚙ 设置": "⚙ Settings",
  "＋ 新转换": "＋ New conversion",
  "下载": "Download",
  "删除": "Delete",
  "取消": "Cancel",
  "清空": "Clear",
  "移除": "Remove",
  "查看": "Open",
  "页": "pages",
  "字": "chars",
  "份文件": "files",
  "份文件 ·": "files ·",
  "份文档": "documents",
  "旧版": "legacy",
  "旧版转换": "legacy conversion",
  "已用时": "Elapsed",
  "总用时": "Total time",
  "页/分钟": "pages/min",
  "正在读取…": "Loading…",
  "正在处理…": "Working…",
  "正在转换…": "Converting…",
  "正在保存…": "Saving…",
  "合并中…": "Merging…",
  // ---- 隐私标签 ----
  "文件不上传": "nothing uploaded",
  "本地处理 · 文件不上传": "Local · nothing uploaded",
  "AI 精校 · 页面图像会发送给所选模型": "AI refine · page images go to your model",
  "本地转换 · 仅摘要用于 AI 打标签": "Local · only a summary is sent for tagging",
  "转换正文全程在本机；完成后会把文档开头约 3000 字发给当前服务商生成主题标签。点此可在设置里关闭。": "Conversion itself stays on this machine; afterwards the first ~3000 characters are sent to your provider to generate topic tags. Click to turn this off in Settings.",
  // ---- 首页 ----
  "拖进来、选模式、开始。转换在本机服务里排队执行，关掉页面也会继续。": "Drop files, pick a mode, start. Conversions queue in the local service and keep running if you close the page.",
  "PDF/PPT 转换器": "PDF/PPT converter",
  "拖放一个或多个 PDF / PPT": "Drop one or more PDF / PPT files",
  "或点击批量选择文件": "or click to choose files",
  "AI 模式会把页面图像发送给你配置的模型": "AI mode sends page images to the model you configured",
  "当前模式全程在本机处理": "This mode runs entirely on this machine",
  "转换模式": "Mode",
  "本地快速": "Fast (local)",
  "本地高精度": "High accuracy (local)",
  "AI 精校": "AI refine",
  "直接读取 PDF 文字层，适合普通电子文档。": "Reads the PDF text layer. Good for ordinary digital documents.",
  "本机 Surya 逐页识别版面、表格与公式，速度较慢。": "Surya recognizes layout, tables and formulas on every page. Slow.",
  "本机 Surya 逐页识别版面、表格与公式。": "Surya recognizes layout, tables and formulas on every page.",
  "直接把页面图像交给视觉模型识别（不跑本地 Surya），文字层作提示与回退。": "Sends each page image to a vision model (no local Surya); the text layer is the hint and fallback.",
  "秒级 · 免费 · 不上传": "seconds · free · nothing uploaded",
  "约 1 分钟/页 · 免费 · 不上传": "~1 min/page · free · nothing uploaded",
  "约 15 秒/页 · 按页计费 · 上传页面图像": "~15 s/page · paid per page · uploads page images",
  "精校范围": "Refine scope",
  "全部页面 · 质量最佳": "All pages · best quality",
  "只精校公式、选项与可疑页 · 更省": "Only formulas, options and flagged pages · cheaper",
  "正在进行的任务": "Jobs in progress",
  "关掉页面也会继续跑": "keeps running if you close the page",
  "排队中": "queued",
  "处理中": "working",
  "待转换文件": "Files to convert",
  "最近转换": "Recent",
  "全部 {n} 份 →": "All {n} →",
  "已选 {n} 份，待转换": "{n} selected, ready to convert",
  "开始转换 · {mode}": "Start · {mode}",
  "服务端进行中 · {n}": "Running on the server · {n}",
  "{n} 页待检查": "{n} pages to check",
  // ---- 批次页 ----
  "正在批量转换": "Converting batch",
  "批量处理完成": "Batch complete",
  "{n} 份 PDF · {mode} · 已处理 {done} / {total}": "{n} files · {mode} · {done} / {total} processed",
  "下载合并 .md": "Download merged .md",
  "＋ 新批次": "＋ New batch",
  "总体进度": "Overall",
  "转换成功": "Succeeded",
  "处理失败": "Failed",
  "等待中": "Waiting",
  "已完成": "Done",
  "失败": "Failed",
  "等待处理": "Waiting",
  "已提交，等待服务端处理…": "Submitted, waiting for the server…",
  "处理失败，其余文件继续": "Failed; the rest continue",
  "转换失败。": "Conversion failed.",
  "转换未完成。": "Conversion did not finish.",
  "可以关掉页面，队列在本机服务里继续跑，回来时从这个地址就能接着看。单个文件失败不会中断后续文件；成功结果已自动存入 Library。": "You can close this page; the queue keeps running in the local service and this URL brings you back. One file failing does not stop the others; finished results are already in the Library.",
  "{n} 份 · {time}": "{n} files · {time}",
  // ---- 进度页 ----
  "视觉模型识别中": "Vision model reading pages",
  "正在本机转换": "Converting locally",
  "正在读取 PDF 结构…": "Reading PDF structure…",
  "页面图像会发送给你在设置中选择的模型；识别失败的页面回退 PDF 文字层。": "Page images go to the model chosen in Settings; pages that fail fall back to the PDF text layer.",
  "转换在本机服务里进行，关掉页面也会继续。": "Runs in the local service; closing the page does not stop it.",
  // ---- 错误页 ----
  "转换未完成": "Not finished",
  "PPT 没能转成 PDF": "The PPT could not be converted to PDF",
  "AI 精校还没配置好": "AI refine is not set up yet",
  "PDF 和记录对不上": "The PDF does not match the record",
  "找不到这条记录": "Record not found",
  "这个文件暂时没能处理": "This file could not be processed",
  "打开设置": "Open Settings",
  "换一个文件": "Try another file",
  "请选择 PDF 或 PPT 文件。": "Please choose a PDF or PPT file.",
  "转换失败，请换一个 PDF 再试。": "Conversion failed. Try another PDF.",
  "AI 精校尚未配置。请先在设置中选择服务商、模型并保存 API Key。": "AI refine is not configured. Choose a provider and model in Settings and save an API key.",
  "任务不存在或已被清除。": "The job does not exist or was removed.",
  "这份任务没有完成。": "This job did not finish.",
  "无法打开这份记录。": "Could not open this record.",
  "找不到这个批次，可能已被删除。": "Batch not found; it may have been deleted.",
  "无法打开这个批次。": "Could not open this batch.",
  "AI 精校未完成。": "AI refine did not finish.",
  "AI 精校失败。": "AI refine failed.",
  "正在复用 Library 中的本地初稿…": "Reusing the local draft from the Library…",
  // ---- 结果页 ----
  "转换完成 · 已存入 Library": "Done · saved to Library",
  "{pages} 页 · {mode} · {seconds} 秒": "{pages} pages · {mode} · {seconds} s",
  "← 返回 Library": "← Library",
  "← 返回批次": "← Batch",
  "← 返回首页": "← Home",
  "重新 AI 精校": "Re-run AI refine",
  "用 AI 精校这份": "Refine with AI",
  "已复制": "Copied",
  "复制 Markdown": "Copy Markdown",
  "下载 .md": "Download .md",
  "通过校验": "Passed",
  "建议检查": "To review",
  "LaTeX 公式": "LaTeX formulas",
  "导出完整报告 ↗": "Export full report ↗",
  "逐页质量": "Per-page quality",
  "AI 前后对照": "AI before/after",
  "原始 PDF": "Original PDF",
  "查看方式": "View",
  "渲染": "Rendered",
  "源码": "Source",
  "第 {n} 页": "Page {n}",
  "程序校验通过": "Passed validation",
  "{f} 个公式 · {o} 个选项标签": "{f} formulas · {o} option labels",
  "{n} 字符": "{n} chars",
  "采用 {model}": "Using {model}",
  "AI 未通过 · 回退文字层": "AI rejected · text layer",
  "回退本地初稿": "Fell back to local draft",
  "最终 Markdown": "Final Markdown",
  "PDF 文字层（提示/回退）": "PDF text layer (hint / fallback)",
  "Surya 本地初稿": "Surya local draft",
  "这次没有 AI 对照记录": "No AI comparison for this run",
  "使用“重新 AI 精校”后，这里会保留最终结果与本地初稿。": "After \"Re-run AI refine\", the final text and the local draft are kept here side by side.",
  "原始 PDF 预览": "Original PDF preview",
  "重新精校失败，已保留原结果：{reason}": "Re-refine failed, previous result kept: {reason}",
  "视觉模型": "vision model",
  "AI 未通过校验 · 已回退 Surya": "AI failed validation · Surya draft kept",
  "Surya 本地视觉识别": "Surya local recognition",
  "本地 OCR": "Local OCR",
  "PDF 文字层": "PDF text layer",
  "未识别": "Unrecognized",
  // ---- Library ----
  "你的分析资料库": "Your library",
  "PDF、Markdown、原始初稿与逐页质量记录都保留在这台设备。": "PDFs, Markdown, drafts and per-page quality records all stay on this machine.",
  "搜索文件名或标签…": "Search filenames or tags…",
  "搜索资料库": "Search library",
  "⭳ 全部打包下载": "⭳ Download everything",
  "墨页合并": "moye-merged",
  "墨页合集": "moye-batch",
  "⭳ 下载合并 .md": "⭳ Download merged .md",
  "⭳ 下载这个合集": "⭳ Download this batch",
  "清除选择": "Clear selection",
  "已选 {n} 份": "{n} selected",
  "正在读取资料库…": "Loading library…",
  "批量转换": "Batch",
  "{n} 份 · {pages} 页": "{n} files · {pages} pages",
  "· {n} 份失败": "· {n} failed",
  "· {n} 份进行中": "· {n} running",
  "没有匹配的文件": "No matching files",
  "资料库还是空的": "The library is empty",
  "换个关键词试试。": "Try another keyword.",
  "完成第一次转换后，文件会自动出现在这里。": "Files appear here after your first conversion.",
  "开始第一次转换": "Start your first conversion",
  "选中用于合并下载": "Select for merged download",
  "选中 {name} 用于合并下载": "Select {name} for merged download",
  "打开 {name}": "Open {name}",
  "下载 {name}": "Download {name}",
  "删除 {name}": "Delete {name}",
  "没有可预览的文字": "No preview text",
  "{n} 页 AI 精校": "{n} pages AI-refined",
  "检查通过": "All clear",
  "资料库读取失败。": "Could not load the library.",
  "删除失败。请稍后再试。": "Delete failed. Try again later.",
  "合并下载失败，请稍后再试。": "Merged download failed. Try again later.",
  "从本机资料库删除“{name}”？此操作无法撤销。": "Delete \"{name}\" from the library? This cannot be undone.",
  // ---- 统计 ----
  "我的统计": "My stats",
  "你的墨页数据": "Your Moye stats",
  "页已转换": "pages converted",
  "累计页数": "Pages over time",
  "数据还不够画图": "Not enough data yet",
  "关注领域": "Topics",
  "补标签": "Backfill tags",
  "补标签中 {done}/{total}": "Tagging {done}/{total}",
  "还没有标签 —— 点右上角“补标签”生成": "No tags yet — click \"Backfill tags\" to generate them",
  // ---- 设置 ----
  "AI 精校设置": "AI refine settings",
  "关闭设置": "Close settings",
  "隐私说明": "Privacy",
  "AI 模式下，页面的 JPEG 图像和 PDF 文字层提示会发送给你选择的模型服务。API Key 仅保存在本项目的本机": "In AI mode, page JPEGs and the text-layer hint are sent to the model service you choose. API keys are stored only on this machine in",
  "，不会写入 Library 或浏览器页面数据。": " and never written to the Library or the page.",
  "模型服务商": "Provider",
  "Qwen 百炼": "Qwen (DashScope)",
  "多渠道并行": "Multi-provider",
  "页面按并发能力分给下面勾选的渠道。上面选的服务商只决定「测试连接」测哪一家。": "Pages are spread across the providers checked below by capacity. The provider selected above only decides which one \"Test connection\" tests.",
  "关闭时只用上面选中的 {provider} 一家。不同渠道打的是不同上游，配额互不占用。": "Off: only {provider} is used. Providers hit different upstreams and do not share quota.",
  "还没有配置任何 API Key": "No API key configured yet",
  "{n} 路": "{n} slots",
  "合计并发": "Total concurrency",
  "路 · 实测 84 路可靠，再往上会有请求挂死": "slots · 84 measured reliable, beyond that requests hang",
  "已配置 {masked}；留空则保留原值": "Configured {masked}; leave empty to keep it",
  "尚未配置": "Not configured",
  "在 Kimi 开放平台创建 API Key": "Create a key on the Kimi open platform",
  "Key 与调用地域必须一致": "Key and region must match",
  "并行密钥": "Parallel keys",
  "实测：同一 Google": "Measured: keys under the same Google",
  "账号": "account",
  "下的 Key（哪怕分属不同项目）共用同一份吞吐，加了不会更快；": "share one throughput budget even across projects, so adding them does not help;",
  "换一个 Google 账号": "a different Google account",
  "的 Key 才是独立配额——实测两个账号并行提速": "gets its own quota — two accounts measured",
  "3.3 倍": "3.3× faster",
  "并发 = 6 × 独立项目数": "concurrency = 6 × independent accounts",
  "{n} 把 Key · 并发 {c}": "{n} keys · concurrency {c}",
  "上方主 Key": "Primary key above",
  "主": "primary",
  "已保存": "saved",
  "留空则保留原值": "leave empty to keep",
  "AIza… （另一个 Google 账号的 Key）": "AIza… (a key from another Google account)",
  "移除第 {n} 把 Key": "Remove key #{n}",
  "＋ 添加一把 Key": "＋ Add a key",
  "其中来自几个独立账号": "from how many separate accounts",
  "主模型": "Model",
  "失败回退模型": "Fallback model",
  "Kimi 视觉模型": "Kimi vision model",
  "阿里云百炼 API Key": "DashScope API key",
  "Qwen 视觉 / OCR 模型": "Qwen vision / OCR model",
  "默认使用北京公共兼容地址；也可替换成百炼业务空间专属 compatible-mode/v1 地址。": "Defaults to the Beijing public endpoint; you can use your workspace's own compatible-mode/v1 URL.",
  "视觉模型 ": "Vision model",
  "↻ 从服务商同步模型": "↻ Sync models from provider",
  "需要先填写 API Key；只显示可用于图片输入的模型。": "Needs an API key; only image-capable models are listed.",
  "全部页面（质量最佳）": "All pages (best quality)",
  "只精校公式、选项与可疑页面（更省费用）": "Only formulas, options and flagged pages (cheaper)",
  "自动打标签": "Auto-tagging",
  "转换完成后用当前服务商给文档打 2–4 个主题标签（会把文档开头约 3000 字发出去，本地模式也一样）": "After each conversion, ask the current provider for 2–4 topic tags (sends the first ~3000 characters, in local modes too)",
  "测试连接": "Test connection",
  "保存设置": "Save",
  "已保存到本机。密钥不会出现在网页数据或 Library 中。": "Saved on this machine. Keys never appear in page data or the Library.",
  "设置保存失败。": "Could not save settings.",
  "正在连接模型…": "Connecting to the model…",
  "连接成功：{provider} / {model}": "Connected: {provider} / {model}",
  "连接测试失败。": "Connection test failed.",
  "正在从服务商读取可用模型…": "Fetching available models…",
  "已同步 {n} 个支持图片的模型。": "Synced {n} image-capable models.",
  "模型列表同步失败。": "Could not sync the model list.",
  "选择模型预设": "Choose a model preset",
  "自定义 Model ID": "Custom model ID",
  "模型 ID": "Model ID",
  "输入 Model ID": "Enter a model ID",
  "· 服务商返回": "· from provider",
  "Gemini 2.5 Flash · 推荐": "Gemini 2.5 Flash · recommended",
  "Gemini 2.5 Pro · 更强": "Gemini 2.5 Pro · stronger",
  "Kimi K2.6 · 当前原生视觉推荐": "Kimi K2.6 · recommended native vision",
  "Kimi K2.5 · 多模态": "Kimi K2.5 · multimodal",
  "Qwen3.7 Plus · 当前稳定推荐 / 结构化输出": "Qwen3.7 Plus · stable, structured output",
  "Qwen3.8 Max Preview · 最强预览 / Token Plan": "Qwen3.8 Max Preview · strongest preview / Token Plan",
  "Qwen3.7 Max 06-08 · 增强视觉": "Qwen3.7 Max 06-08 · enhanced vision",
  "Qwen3.7 Flash · 当前低成本": "Qwen3.7 Flash · low cost",
  "Qwen3.7 Flash 07-15 · 固定快照": "Qwen3.7 Flash 07-15 · pinned snapshot",
  "Qwen3.6 Plus · 平衡": "Qwen3.6 Plus · balanced",
  "Qwen3.6 Flash · 低成本": "Qwen3.6 Flash · low cost",
  "Qwen VL OCR · 文档/表格/试卷/手写": "Qwen VL OCR · documents / tables / exams / handwriting",
  "Kimi K2.6 · 数学/理科推荐 · 公式最全": "Kimi K2.6 · best for math/science · most formulas",
  "Qwen3.7 Flash · 纯文字推荐 · 最快最便宜": "Qwen3.7 Flash · best for plain text · fastest, cheapest",
  "GLM-5V Turbo · 备选": "GLM-5V Turbo · alternative",
  "Gemini 2.5 Flash · 与直连同配额，不建议": "Gemini 2.5 Flash · shares quota with direct Gemini, not recommended",
  // ---- 页脚 ----
  "墨页 · Verifiable document tools": "Moye · Verifiable document tools",
  "本地初稿 · 可选云端精校 · 逐页留痕": "Local draft · optional cloud refine · per-page audit trail",
  "当前处理仅在你的设备完成": "Everything so far ran on this device",
  // ---- 零散 ----
  "（部分未读出）": " (some not read yet)",
  "已完成并存入 Library · {n} 页": "Done, saved to Library · {n} pages",
  "来源文件": "Source file",
  "墨页批量转换": "moye-batch",
  "通过 {providers}": "via {providers}",
  "移除 {name}": "Remove {name}",
  // ---- 时间 ----
  "{n} 秒": "{n} s",
  "{m} 分 {s} 秒": "{m} min {s} s",
  "{h} 时 {m} 分": "{h} h {m} min",
};

/**
 * @param key 中文原文（可含 {n} 之类占位符）
 * @param vars 插值
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let text = activeLang === "en" ? (en[key] ?? key) : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/**
 * 服务端发来的动态文本（进度、原因、错误）。服务端只说中文，这里按模式翻译
 * 常见的几十种；对不上的原样返回。模式按出现频率排，先匹配先用。
 */
const serverPatterns: [RegExp, string][] = [
  // 进度（server/convert.mjs、queue.mjs、jobstore.mjs）
  [/^已完成 (\d+)\/(\d+) 页$/, "Done $1/$2 pages"],
  [/^读取文字层作为提示 (\d+)\/(\d+) 页，随后交给视觉模型$/, "Reading text layer $1/$2 pages as hints, then the vision model"],
  [/^读取文字层 (\d+)\/(\d+) 页$/, "Reading text layer $1/$2 pages"],
  [/^(\d+) 页待识别，按 (\d+) 页一组滚动生成图像$/, "$1 pages to recognize, rendering $2 at a time"],
  [/^续跑：已有 (\d+) 页存档，跳过$/, "Resuming: $1 pages already archived"],
  [/^补救 (\d+) 页失败的识别$/, "Retrying $1 failed pages"],
  [/^第 (\d+) 页跳过$/, "Page $1 skipped"],
  [/^第 (\d+) 页完成$/, "Page $1 done"],
  [/^读取第 (\d+) 页文字层$/, "Reading text layer of page $1"],
  [/^正在使用 Surya 逐页解析/, "Surya is parsing layout, tables and formulas page by page (the first run is slow)"],
  [/^本地高精度初稿完成$/, "Local high-accuracy draft finished"],
  [/^开始处理$/, "Starting"],
  [/^完成$/, "Done"],
  [/^已取消$/, "Cancelled"],
  [/^服务重启，已重新排队$/, "Service restarted, re-queued"],
  [/^重新精校排队中/, "Queued for re-refine, reusing the current result as the draft"],
  // 逐页原因（convert.mjs）
  [/^文字层过少；扫描页或公式页请改用本地高精度$/, "Very little text layer; use High accuracy for scanned or formula pages"],
  [/^本地视觉识别报告了异常区块$/, "Local recognition reported problem blocks"],
  [/^包含图像或示意图，建议核对$/, "Contains images or diagrams; check against the PDF"],
  [/^本地高精度识别后仍未检测到文字$/, "No text detected even after local recognition"],
  [/^AI 结果未通过程序校验：(.+)$/, "AI result failed validation: $1"],
  [/^模型标记不确定：(.+)$/, "Model marked as uncertain: $1"],
  [/^结果中仍有无法辨认的符号$/, "Unreadable symbols remain in the result"],
  [/^AI 识别失败，已回退 PDF 文字层：(.+)$/, "AI failed, fell back to the text layer: $1"],
  [/^AI 识别失败，且此页没有文字层可回退：(.+)$/, "AI failed and this page has no text layer to fall back to: $1"],
  // 错误（local-ocr-server.mjs / convert.mjs）
  [/^AI 精校尚未配置/, "AI refine is not configured. Open Settings and add an API key."],
  [/^请求超时（(\d+)s 未返回）。$/, "Request timed out ($1 s)."],
  [/^重新精校失败，已保留原结果：(.+)$/, "Re-refine failed, previous result kept: $1"],
  [/^页面渲染超时/, "Page rendering timed out."],
  [/^PPT 转 PDF 失败：(.+)$/, "PPT → PDF failed: $1"],
  [/^原 PDF 页数与 Library 记录不一致/, "The PDF page count does not match the Library record; the draft cannot be reused."],
  [/^服务重启时源文件已丢失。$/, "The source file was lost when the service restarted."],
  [/^记录不存在。$/, "Record not found."],
  [/^结果尚未生成。$/, "The result is not ready yet."],
];

export function tServer(text: string | null | undefined): string {
  if (!text) return "";
  if (activeLang !== "en") return text;
  for (const [pattern, replacement] of serverPatterns) {
    const m = text.match(pattern);
    if (m) return replacement.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
  }
  return text;
}

/** 给 serverPatterns 追加条目（放在文件末尾集中定义，见 server-strings 段）。 */
export function defineServerStrings(entries: [RegExp, string][]) {
  serverPatterns.push(...entries);
}
