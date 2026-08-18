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
  constructor(provider, max, min, slowMs) {
    this.provider = provider;
    // 「慢」的门槛按渠道各自定：三家正常速度差 8 倍（CoreWeave 3s / qwen 13s /
    // gemini 25s），用一个统一阈值会把慢渠道的正常响应误判成拥塞并把它降到最低。
    this.slowMs = slowMs;
    this.max = Math.max(1, max);
    this.min = Math.max(1, Math.min(min, this.max));
    // 满速起步。曾经从 max/4 起步「保守探测」，实测是灾难：三条车道合计只有
    // 14 路在跑而上限是 60，闸外积压 346 个请求——因为涨一格要连续成功 limit 次，
    // 而上游偶发失败一来就砍半，于是永远在低位震荡，爬不上去。
    // 正确的做法是先按上限跑，撞墙了再退——退让必须比试探便宜，否则代价全落在等待上。
    this.limit = this.max;
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
    // 恢复要快：每 4 次成功涨 1。原来要求「连续成功 limit 次」，在 limit=40 时
    // 等于四十次不出错才敢涨一格，实际永远达不到。
    if (this.wins >= 4 && this.limit < this.max) {
      this.limit += 1;
      this.wins = 0;
    }
  }

  onFailure(now) {
    this.totalFail += 1;
    this.wins = 0;
    // 冷却：一批请求往往同时超时，若每个都砍，limit 会一瞬间掉到底。
    if (now - this.lastCut < 5000) return;
    this.lastCut = now;
    // 退到 70% 而不是砍半。偶发超时是常态（上游吞吐本身波动 3 倍），
    // 砍半会让一次抖动就损失一半产能，而爬回来要很久。
    this.limit = Math.max(this.min, Math.floor(this.limit * 0.7));
  }
}

export class AdaptivePacer {
  /**
   * @param {object} opts
   * @param {number} opts.minPerChannel 每条车道的最低并发（再差也要留一点，否则永远爬不回来）
   * @param {number} opts.slowMs 超过这个耗时的「成功」也算拥塞信号，见 run() 的说明
   */
  constructor({ minPerChannel = 2, slowMs = 45000 } = {}) {
    this.minPerChannel = minPerChannel;
    this.slowMs = slowMs;
    this.lanes = new Map();
    this.waiters = [];
  }

  /**
   * 设定参与的渠道及各自上限。可以反复调用（用户改设置后下一页就生效）；
   * 已存在的车道保留它当前学到的速度，不会被重置回起点。
   */
  configure(channels) {
    const seen = new Set();
    for (const { provider, weight, slowMs } of channels) {
      seen.add(provider);
      const lane = this.lanes.get(provider);
      if (lane) {
        lane.max = Math.max(1, weight);
        lane.limit = Math.min(lane.limit, lane.max);
        if (slowMs) lane.slowMs = slowMs;
      } else {
        this.lanes.set(provider, new Lane(provider, weight, this.minPerChannel, slowMs || this.slowMs));
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

    const startedAt = Date.now();
    try {
      const result = await fn(lane.provider);
      // 「慢的成功」也是拥塞信号。单次调用超时是 30s，所以一个跑了几分钟才回来的
      // 「成功」意味着它在底下反复超时、换供应商，最后才撞上一个能用的——
      // 这正是过载的样子。只看最终成败会把这种情况当成健康，于是永不降速：
      // 实测 60 路时零失败，但平均每个请求 218 秒，吞吐只有 11 页/分钟。
      if (Date.now() - startedAt > (lane.slowMs || this.slowMs)) lane.onFailure(Date.now());
      else lane.onSuccess();
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
