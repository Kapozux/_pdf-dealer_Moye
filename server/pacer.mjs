/**
 * 按渠道自适应的发送节流器。
 *
 * 为什么需要它
 * ------------
 * 原来的做法是一个全局信号量，上限写死（比如 60）。问题是这个数字**没法写对**：
 * 实测同一个渠道、同样 64 路并发，吞吐在 1.15～3.38 页/秒之间波动，差 3 倍——
 * 上游忙不忙是随时在变的。写死的值忙时会打穿、闲时会浪费。
 *
 * 实测教训（2026-08-18，15 份大文档 537 页）：按突发压测得到的「每家能扛 8 路」
 * 把总并发设成 40–60，结果持续跑几十分钟后上游被打穿，537 页里 241 页超时回退，
 * 换供应商触发 1992 次也救不回来——因为几家是**同时**被打满的，换过去还是满的。
 *
 * 怎么做
 * ------
 * 跟 TCP 拥塞控制同一个思路（AIMD）：
 *   成功 → 慢慢加（加法增长，越快越难再涨）
 *   超时 → 立刻砍半（乘法减少）
 * 这样它会自己收敛到「当前上游真正吃得下」的水平，并随上游状况实时调整。
 *
 * 每个渠道一条独立车道
 * --------------------
 * 各渠道打的是不同上游，忙闲互不相干。一条车道被打崩只会让**它自己**降速，
 * 而派活时优先选空位最多的车道，于是流量自动从崩掉的平台流向健康的平台，
 * 不需要人工干预，也不需要提前知道哪家会崩。
 */

class Lane {
  constructor(provider, max, min) {
    this.provider = provider;
    this.max = Math.max(1, max);
    this.min = Math.max(1, Math.min(min, this.max));
    // 保守起步：从上限的 1/4 开始探，而不是一上来就顶格——
    // 一上来顶格正是今天把上游打穿的原因。
    this.limit = Math.max(this.min, Math.ceil(this.max / 4));
    this.inFlight = 0;
    this.wins = 0;         // 上次涨速以来连续成功数
    this.lastCut = 0;      // 上次降速时刻（用于冷却）
    this.totalOk = 0;
    this.totalFail = 0;
  }

  free() {
    return this.limit - this.inFlight;
  }

  onSuccess() {
    this.totalOk += 1;
    this.wins += 1;
    // 加法增长：攒够「当前 limit 次」成功才涨 1。
    // 用 limit 而不是固定次数，是为了让速度越高越难再涨，避免冲过头。
    if (this.wins >= this.limit && this.limit < this.max) {
      this.limit += 1;
      this.wins = 0;
    }
  }

  onFailure(now) {
    this.totalFail += 1;
    this.wins = 0;
    // 冷却：一批请求往往同时超时，若每个都砍一半，limit 会一瞬间掉到底。
    // 一次降速后 5 秒内的失败视为同一波，不重复惩罚。
    if (now - this.lastCut < 5000) return;
    this.lastCut = now;
    this.limit = Math.max(this.min, Math.floor(this.limit / 2));
  }
}

export class AdaptivePacer {
  /**
   * @param {object} opts
   * @param {number} opts.minPerChannel 每条车道的最低并发（再差也要留一点，否则永远爬不回来）
   */
  constructor({ minPerChannel = 2 } = {}) {
    this.minPerChannel = minPerChannel;
    this.lanes = new Map();
    this.waiters = [];
  }

  /**
   * 设定参与的渠道及各自上限。可以反复调用（用户改设置后下一页就生效）；
   * 已存在的车道保留它当前学到的速度，不会被重置回起点。
   */
  configure(channels) {
    const seen = new Set();
    for (const { provider, weight } of channels) {
      seen.add(provider);
      const lane = this.lanes.get(provider);
      if (lane) {
        lane.max = Math.max(1, weight);
        lane.limit = Math.min(lane.limit, lane.max);
      } else {
        this.lanes.set(provider, new Lane(provider, weight, this.minPerChannel));
      }
    }
    for (const provider of [...this.lanes.keys()]) {
      // 渠道被关掉了：等它手上的请求跑完再移除，不能直接丢
      if (!seen.has(provider) && this.lanes.get(provider).inFlight === 0) this.lanes.delete(provider);
    }
    this._drain();
  }

  /** 空位最多的车道。被打崩的车道 limit 小、空位少，自然分不到活。 */
  _pickLane() {
    let best = null;
    for (const lane of this.lanes.values()) {
      if (lane.free() <= 0) continue;
      if (!best || lane.free() > best.free()) best = lane;
    }
    return best;
  }

  _drain() {
    while (this.waiters.length) {
      const lane = this._pickLane();
      if (!lane) break;
      lane.inFlight += 1;
      this.waiters.shift()(lane);
    }
  }

  /**
   * 取一个车道执行 fn(provider)。没有空位就排队等——这就是背压：
   * 上游慢下来时，等待队列变长，而不是把更多请求硬塞进去。
   */
  async run(fn) {
    if (!this.lanes.size) throw new Error("没有可用的模型渠道。");
    let lane = this._pickLane();
    if (lane) lane.inFlight += 1;
    else lane = await new Promise((resolve) => this.waiters.push(resolve));

    try {
      const result = await fn(lane.provider);
      lane.onSuccess();
      return result;
    } catch (error) {
      lane.onFailure(Date.now());
      throw error;
    } finally {
      lane.inFlight -= 1;
      this._drain();
    }
  }

  stats() {
    return {
      waiting: this.waiters.length,
      lanes: [...this.lanes.values()].map((l) => ({
        provider: l.provider,
        limit: l.limit,
        max: l.max,
        inFlight: l.inFlight,
        ok: l.totalOk,
        fail: l.totalFail,
      })),
    };
  }
}
