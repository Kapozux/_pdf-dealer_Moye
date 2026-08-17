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
   * @param {Record<string, number>} opts.concurrency 每种模式各自的并发上限
   */
  constructor({ store, run, concurrency = {} }) {
    super();
    this.store = store;
    this.run = run;
    // 按模式分别限流：三种模式的瓶颈完全不同，用一个数字管所有模式，
    // 要么把本机 CPU 打爆（Surya 开多路），要么让纯网络任务白白排队（AI）。
    this.limits = {
      fast: 4,       // 只读文字层，几乎不耗资源
      balanced: 1,   // 本机 Surya，吃满 CPU/GPU
      math: 1,
      ai: 4,         // 主要在等远端模型；内层还有 Surya 闸兜底（见 convert 的 suryaGate）
      ...concurrency,
    };
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

  /** 协作式取消：跑到下一个安全点就停，已完成的产物保留。 */
  cancel(jobId) {
    const idx = this.pending.indexOf(jobId);
    if (idx !== -1) {
      this.pending.splice(idx, 1);
      this.store.update(jobId, { status: "cancelled", detail: "已取消" });
      this._emitJob(jobId);
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
      if ((running[mode] ?? 0) >= this._limitFor(mode)) {
        skipped.push(jobId);       // 这个模式满了，留在队列里等
        continue;
      }
      running[mode] = (running[mode] ?? 0) + 1;
      this._start(jobId);
    }
    this.pending = skipped.concat(this.pending);
  }

  async _start(jobId) {
    const token = { cancelled: false };
    this.active.set(jobId, token);
    this.store.update(jobId, { status: "running", detail: "开始处理", error: null });
    this._emitJob(jobId);

    // 进度回调做节流：逐页回调很密集，没必要每次都写库 + 广播
    let lastWrite = 0;
    const onProgress = (page, total, detail = "") => {
      const now = Date.now();
      const isEdge = page === 0 || page >= total;
      if (!isEdge && now - lastWrite < 300) return;
      lastWrite = now;
      this.store.update(jobId, {
        page: Math.floor(page),
        total: Math.floor(total),
        detail: String(detail).slice(0, 200),
      });
      this._emitJob(jobId);
    };

    try {
      const job = this.store.get(jobId);
      const result = await this.run(job, onProgress, token);
      if (token.cancelled) {
        this.store.update(jobId, { status: "cancelled", detail: "已取消" });
      } else {
        await this.store.saveResult(jobId, result);
        this.store.update(jobId, {
          status: "done",
          detail: "完成",
          page: result.pageCount ?? 0,
          total: result.pageCount ?? 0,
        });
      }
    } catch (error) {
      this.store.update(jobId, {
        status: token.cancelled ? "cancelled" : "failed",
        error: String(error?.message ?? error).slice(0, 500),
      });
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
