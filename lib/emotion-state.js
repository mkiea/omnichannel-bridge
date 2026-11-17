/**
 * 表情绪状态（2026-11-11）。
 *
 * 三条约定（本模块的取舍，不是通用结论）：
 * - 情绪是「类型 × 强度」，不是一个标量；
 * - 快层（秒–分钟）会衰减，慢层（人格）不变；
 * - 有界：任何情绪都不能越过包络。
 *
 * 这一层解决的是"单轮情绪"的问题：原来每句话独立判一次，
 * 被连着逗三次和只逗一次，语音听起来一模一样。现在会累积、会衰减、有上限。
 *
 * ⚠️ 这是简化版：只做「强度累积 + 半衰」，没做本地研究里的「对象轴」和
 * 「事件→评价→情绪」；那两步要事件结构，等有真实事件流再接。
 */

const DEFAULTS = {
  /** 半衰期：多少分钟后强度减半。10 分钟 = 一场对话内的"余温"。 */
  halfLifeMinutes: 10,
  /** 累积系数：旧值保留多少（0=完全覆盖，1=不变）。 */
  keep: 0.6,
  /** 新值权重：一次情绪冲击能贡献多少。 */
  fresh: 0.7,
  /** 低于这个强度就当没有了，避免 Map 里全是 0.01 的残渣。 */
  floor: 0.05,
  /** 上限：单类情绪最高 1.0（包络的上界）。 */
  cap: 1,
}

export class EmotionState {
  constructor(options = {}) {
    this.tuning = { ...DEFAULTS, ...options }
    this.emotions = new Map()
    this.lastAt = Number(options.now) || Date.now()
  }

  /** 按经过的时间做指数衰减（半衰期）。 */
  decay(now = Date.now()) {
    const minutes = Math.max(0, (now - this.lastAt) / 60_000)
    if (minutes <= 0) return this
    const factor = Math.pow(0.5, minutes / this.tuning.halfLifeMinutes)
    for (const [name, value] of this.emotions) {
      const next = value * factor
      if (next < this.tuning.floor) this.emotions.delete(name)
      else this.emotions.set(name, next)
    }
    this.lastAt = now
    return this
  }

  /**
   * 记一次情绪冲击。
   * `prev × keep + fresh × intensity`，封顶 `cap` —— 连续三次同一种情绪会明显累积，
   * 但不会无限涨（有界）。
   */
  update(emotion, intensity = 0.6, now = Date.now()) {
    this.decay(now)
    const name = String(emotion ?? '').trim()
    if (name === '') return this
    const add = Math.max(0, Math.min(1, Number(intensity) || 0))
    const prev = this.emotions.get(name) || 0
    const next = Math.min(this.tuning.cap, prev * this.tuning.keep + add * this.tuning.fresh)
    if (next < this.tuning.floor) this.emotions.delete(name)
    else this.emotions.set(name, next)
    this.lastAt = now
    return this
  }

  /** 当前最强的情绪（强度相同时保留先出现的，避免抖动）。 */
  dominant(now = Date.now()) {
    this.decay(now)
    let best = ''
    let value = 0
    for (const [name, strength] of this.emotions) {
      if (strength > value) { best = name; value = strength }
    }
    return best === '' ? null : { emotion: best, intensity: value }
  }

  /** 只读快照（测试与诊断用）。 */
  snapshot() {
    return Object.fromEntries(this.emotions)
  }
}
