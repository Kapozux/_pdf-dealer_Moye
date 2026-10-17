/**
 * 任务队列 + 并发闸 + 事件广播。
 *
 * 参考 Verbatim：真正的执行在服务端，浏览器只是个观察者。
 * 关掉标签页、刷新、甚至重启服务，任务照跑（重启由 JobStore.recover 接手）。
 *
 * 并发用一个全局信号量，而不是「每个提交批次各开一组」——
 * 这样一次丢 20 份和分 4 次丢，对 CPU / Surya / 模型配额的瞬时压力是一样的。
 */

import { EventEmitter } from "node:events";

export class JobQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./jobstore.mjs').JobStore} opts.store
   * @param {(job: object, onProgress: Function, signal: {cancelled: boolean}) => Promise<object>} opts.run
   * @param {Record<string, number>|number} opts.concurrency 每种模式各自的上限；
   *        传数字只覆盖本机模式（balanced/math），AI 不跟着变——见下面 ai 的说明。
   * @param {() => number} [opts.aiPageBudget] 此刻全局能同时打向模型几页（aiGate 的上限）；
   *        给了它，AI 车道就按页补满，见 _admits。
   */
  constructor({ store, run, concurrency = {}, aiPageBudget }) {
    super();
    this.store = store;
    this.run = run;
    // 传数字时只当作「本机识别的并发」：以前这里直接 ...concurrency 展开，
    // 而展开一个数字得到的是 {}（`{...1}` === `{}`），所以 MOYE_CONCURRENCY
    // 一直被静默忽略，改它毫无效果。
    const overrides =
      typeof concurrency === "number" ? { balanced: concurrency, math: concurrency } : concurrency;
    // 按模式分别限流：三种模式的瓶颈完全不同，用一个数字管所有模式，
    // 要么把本机 CPU 打爆（Surya 开多路），要么让纯网络任务白白排队（AI）。
    this.limits = {
      fast: 4,       // 只读文字层，几乎不耗资源
      balanced: 1,   // 本机 Surya，吃满 CPU/GPU
      math: 1,
      // AI 模式真正的闸是 convert.mjs 里的全局 aiGate，它限的是「此刻打向模型的
      // 请求总数」；这里限的只是「同时有几份文档在跑」。要的效果是**页级填满**：
      // 文档只是页的来源，aiGate 没满就该继续拉更多文档的页进来。
      // 所以这个数字必须远大于「够用」——它不是并发上限，只是喂料口的宽度。
      // 同时开几份文档。这个数字**要小**，跟直觉相反。
      //
      // 全局并发（aiGate/节流器，当时约 60 路；现在按渠道算，见 CLAUDE.md「架构要点」）是所有文档共享的固定预算。开的文档
      // 越多，每份分到的越少：48 份同时跑时每份只有 ~5 路，一份 60 页的文档要
      // 12 轮才跑完。而产物只在整份完成时才落盘，于是十几份一起龟速爬行，
      // 用户很久看不到任何一个成品。
      //
      // 默认 1：一份文档独占全部并发预算，跑完立刻交付下一份。
      // 几十页的文档一份就能吃满 60 路（92 页 = 2 轮 ≈ 30-60 秒），开第二份
      // 只会把两份都拖慢，而产物要整份跑完才落盘，等于两份都晚交付。
      //
      // 但一次转很多**小**文档（每份一两页）时，单份填不满预算：2026-10-17 用 Claude
      // （20 路）转几十张截图，一次只跑一份 = 20 个名额只用 1 个。所以现在按页补满
      // （_admits）：在跑的 AI 文档剩下的页填不满预算，才再开下一份。大书一份就填满，
      // 照旧独占；小文档会一起跑到填满为止。这里的数字只是「最多同时几份」的硬上限。
      ai: Number(process.env.MOYE_AI_JOB_CONCURRENCY) || 8,
      ...overrides,
    };
    this.aiPageBudget = aiPageBudget;
    this.pending = [];        // 等待中的 job id
    this.active = new Map();  // job id → { cancelled }
  }

  /** 入队（已落库的任务）。 */
  enqueue(jobId) {
    if (this.active.has(jobId) || this.pending.includes(jobId)) return;
    this.pending.push(jobId);
    this._emitJob(jobId);
    this._pump();
  }

  /**
   * 协作式取消：跑到下一个安全点就停（convert.mjs 每领一页之前看一眼 token），
   * 已经在途的那几页跑完为止。
   */
  cancel(jobId) {
    const idx = this.pending.indexOf(jobId);
    if (idx !== -1) {
      this.pending.splice(idx, 1);
      this._settleCancelled(jobId)
        .catch((error) => console.error(`[队列] 取消 ${jobId} 时收尾失败：${String(error?.message ?? error).slice(0, 200)}`))
        .finally(() => this._emitJob(jobId));
      return true;
    }
    const token = this.active.get(jobId);
    if (token) {
      token.cancelled = true;
      return true;
    }
    return false;
  }

  status() {
    return {
      active: [...this.active.keys()],
      pending: [...this.pending],
      limits: this.limits,
      runningByMode: this._runningByMode(),
    };
  }

  _limitFor(mode) {
    return Math.max(1, this.limits[mode] ?? 1);
  }

  _runningByMode() {
    const counts = {};
    for (const id of this.active.keys()) {
      const mode = this.store.get(id)?.mode ?? "fast";
      counts[mode] = (counts[mode] ?? 0) + 1;
    }
    return counts;
  }

  _emitJob(jobId) {
    const job = this.store.get(jobId);
    if (job) this.emit("job", job);
  }

  /** 按模式各自的上限调度：某个模式满了不阻塞其他模式（AI 排队时本地任务照跑）。 */
  _pump() {
    const running = this._runningByMode();
    const skipped = [];
    while (this.pending.length) {
      const jobId = this.pending.shift();
      const mode = this.store.get(jobId)?.mode ?? "fast";
      if (!this._admits(mode, running)) {
        skipped.push(jobId);       // 这个模式满了，留在队列里等
        continue;
      }
      running[mode] = (running[mode] ?? 0) + 1;
      // _start 自己兜住了所有错误；这里再接一层，防的是收尾时写库也失败——
      // 没人接的 Promise rejection 会让整个服务进程退出，在跑的任务全部白跑
      this._start(jobId).catch((error) => console.error(`[队列] 任务 ${jobId} 收尾失败：${String(error?.message ?? error).slice(0, 200)}`));
    }
    this.pending = skipped.concat(this.pending);
  }

  /**
   * 这个模式还能不能再开一份。AI 车道多一条：已经有文档在跑时，只有它们剩下的页
   * （总页数 - 已完成，在途的也算）填不满全局预算，才再开。页数还不知道的（刚开始、
   * 还在读 PDF）当作填满——等它报出页数，_start 里的进度回调会再叫一次 _pump。
   *
   * 「当作填满」顺带让新文档一份接一份地进来，别改成一提交就带页数、一次全放进来：
   * 2026-10-17 实测 20 张单页图（Claude 20 路，16 核 Mac，每轮间隔 90s）：
   *   现在这样（同跑 6～7 份）74 / 59 / 76s；提交时带页数（8 份一起开）93 / 80 / 79s，
   *   负载顶到 16——每份都要起 claude、读文字层、渲染几个进程，CPU 先满，模型反而变慢。
   *   以前一次一份约 282s。
   */
  _admits(mode, running) {
    const count = running[mode] ?? 0;
    if (count >= this._limitFor(mode)) return false;
    if (mode !== "ai" || count === 0 || !this.aiPageBudget) return true;
    let remaining = 0;
    for (const id of this.active.keys()) {
      const job = this.store.get(id);
      if (job?.mode !== "ai") continue;
      if (!(job.total > 0)) return false;
      remaining += Math.max(0, job.total - job.page);
    }
    return remaining < this.aiPageBudget();
  }

  /**
   * 取消之后记录落到哪：
   * - 重新精校被取消（磁盘上还有上一次的 result.json）→ 退回「完成」、结果原样不动。
   *   以前标成 cancelled，Library 只列 done，一份好好的文档就这么「消失」了。
   * - 新转换被取消 → cancelled。
   * 这一轮的逐页存档一律作废：取消 = 这次什么都没变，下次重跑也不该续上半截。
   */
  async _settleCancelled(jobId) {
    await this.store.checkpoint?.(jobId).clear().catch((error) =>
      console.warn(`[取消] 清理 ${jobId} 的逐页存档失败：${String(error?.message ?? error).slice(0, 160)}`));
    if (await this.store.hasResult?.(jobId)) {
      const pages = this.store.get(jobId)?.page_count ?? 0;
      this.store.update(jobId, { status: "done", detail: "已取消重新精校，保留原结果", error: null, page: pages, total: pages });
    } else {
      this.store.update(jobId, { status: "cancelled", detail: "已取消" });
    }
  }

  async _start(jobId) {
    const token = { cancelled: false };
    this.active.set(jobId, token);

    // 进度回调做节流：逐页回调很密集，没必要每次都写库 + 广播
    let lastWrite = 0;
    let lastPage = -1;
    const onProgress = (page, total, detail = "") => {
      const now = Date.now();
      // 阶段切换（归零、跑满）和跳变（续跑一次跳几百页、换阶段倒退）必须写库，
      // 只有"逐页 +1"的常规推进才节流——否则续跑的起点会被吞掉，界面停在上一阶段
      const isEdge = page === 0 || page >= total || page < lastPage || page - lastPage > 1;
      if (!isEdge && now - lastWrite < 300) return;
      lastWrite = now;
      lastPage = page;
      this.store.update(jobId, {
        page: Math.floor(page),
        total: Math.floor(total),
        detail: String(detail).slice(0, 200),
      });
      this._emitJob(jobId);
      // AI 车道按剩余页数放行：页数刚报出来、或又跑完几页，排队的文档可能就能进来了
      if (this.pending.length) this._pump();
    };

    try {
      this.store.update(jobId, { status: "running", detail: "开始处理", error: null });
      this._emitJob(jobId);
      const job = this.store.get(jobId);
      const result = await this.run(job, onProgress, token);
      if (token.cancelled) {
        await this._settleCancelled(jobId);
      } else {
        await this.store.saveResult(jobId, result);
        // 结果已完整落盘，逐页存档没用了——留着会占磁盘，
        // 而且这份任务若被「重新精校」复用，旧页会盖掉新结果。
        await this.store.checkpoint?.(jobId).clear().catch((error) =>
          console.warn(`[队列] 清理 ${jobId} 的逐页存档失败，下次重新精校可能读到旧页：${String(error?.message ?? error).slice(0, 160)}`));
        this.store.update(jobId, {
          status: "done",
          detail: "完成",
          page: result.pageCount ?? 0,
          total: result.pageCount ?? 0,
        });
      }
    } catch (error) {
      if (token.cancelled) {
        await this._settleCancelled(jobId);
      } else {
        this.store.update(jobId, { status: "failed", error: String(error?.message ?? error).slice(0, 500) });
      }
    } finally {
      this.active.delete(jobId);
      this._emitJob(jobId);
      this._pump();
    }
  }
}

/** SSE 广播：多个浏览器标签可以同时订阅同一批任务的进度。 */
export class EventHub {
  constructor() {
    this.clients = new Set();
  }

  attach(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": response.getHeader("Access-Control-Allow-Origin") ?? "*",
    });
    response.write(": connected\n\n");
    this.clients.add(response);
    const keepAlive = setInterval(() => {
      try {
        response.write(": ping\n\n");
      } catch {
        /* 断了由 close 清理 */
      }
    }, 15000);
    const cleanup = () => {
      clearInterval(keepAlive);
      this.clients.delete(response);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
  }

  broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
