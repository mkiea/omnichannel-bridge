/**
 * circuit-breaker.js —— 模型回合连续失败时的熔断闸（2026-11-15）
 *
 * 由来：主人要「拦截一下异常调用，然后发给管理员（要有详细日志）」。
 *
 * 形状来自视频 BV1sZWo6PEFG（某两个插件组合白名单缺 compress ⇒ 一直压缩失败 ⇒
 * 一小时烧光 token）。那个具体坑我们不中：桥建会话只传 provider/model、不设工具白名单，
 * dsh 的压缩是自动的且有上限（compactionRetries=1）—— 但**形状**是真的，本机撞过三次
 * （qzone 1404、describe_image 缺失、yt-dlp 缺失）。共同点是"缺东西 ⇒ 每轮都试 ⇒
 * 每一轮都花钱"，而当时唯一挡住它的东西是"恰好有人发现了"。
 *
 * 为什么闸放在「回合」这一层，不放在「请求」那一层：
 *   · 请求层的重试在宿主里（llm-retry，默认 maxRetries=5）。桥插不进去，也不该插 ——
 *     单次抖动**应该**给重试机会，那是它的职责。
 *   · 桥能看见的唯一真相是 `turn/end`：这一回合到底有没有跑完。连续几个回合都报错，
 *     就不再是"某一次运气不好"，而是"上游坏了 / 配置坏了 / 额度没了"。
 *
 * 状态机（标准三态）：
 *   closed    正常放行；`fail` 累加 failures，`ok` 清零。
 *   open      连续失败达阈值；`allow()` 一律 false，冷却 cooldownMs。
 *   half-open 冷却到期；只放**一条**去试探（probeWindowMs 内不放第二条）。
 *             成功 ⇒ closed，并让调用方去通知管理员"恢复了"；
 *             失败 ⇒ 立刻重新 open，冷却重算。
 *
 * 为什么必须落盘：熔断只活在这个进程里的话，宿主一重启就清零 —— 而"上游一直坏"
 * 恰恰常伴随"桥自己在重启"（掉线自愈、launcher 补起）。落盘的是**事实**（失败次数、
 * 打开时刻），不是结论；读到损坏的状态一律当作 closed（宁可放行，不可永久卡死）。
 *
 * 纯逻辑：不读文件、不发网络、不看真实时钟（`now` 可注入）。
 * 这样单测能钉住每一条时间边界，而不用等 10 分钟。
 */

/** 落盘/读盘的字段白名单。多出来的字段一律丢掉，避免旧版本残留污染状态机。 */
const STATE_KEYS = [
  'failures', 'openedAt', 'probingAt', 'opens',
  'lastError', 'lastChatKey', 'lastTurnMs', 'lastAt',
]

function normalize(raw) {
  const out = {
    failures: 0, openedAt: 0, probingAt: 0, opens: 0,
    lastError: '', lastChatKey: '', lastTurnMs: 0, lastAt: 0,
  }
  if (raw === null || typeof raw !== 'object') return out
  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }
  out.failures = num(raw.failures)
  out.openedAt = num(raw.openedAt)
  out.probingAt = num(raw.probingAt)
  out.opens = num(raw.opens)
  out.lastError = typeof raw.lastError === 'string' ? raw.lastError.slice(0, 300) : ''
  out.lastChatKey = typeof raw.lastChatKey === 'string' ? raw.lastChatKey.slice(0, 80) : ''
  out.lastTurnMs = num(raw.lastTurnMs)
  out.lastAt = num(raw.lastAt)
  // 自洽性：有 openedAt 才允许有 probingAt；failures 已经清零就不该还挂着 openedAt。
  if (out.openedAt === 0) out.probingAt = 0
  if (out.failures === 0 && out.openedAt > 0) {
    // 落盘时被打断写坏的组合：留着 openedAt 会让人永远放不进去，按"没打开"处理。
    out.openedAt = 0
    out.probingAt = 0
  }
  return out
}

/**
 * @param {object} [options]
 * @param {object|null} [options.state] 上次落盘的状态（`snapshot()` 的形状）
 * @param {number} [options.threshold=3] 连续失败多少次开闸
 * @param {number} [options.cooldownMs=600000] 开闸后多久允许试探（默认 10 分钟）
 * @param {number} [options.probeWindowMs=180000] half-open 只放一条；这条的回合最长算这么久
 * @param {() => number} [options.now] 时钟（单测注入）
 * @param {(state: object) => void} [options.onChange] 状态变化回调（落盘用；不要在这里抛）
 */
export function createTurnBreaker(options = {}) {
  const threshold = Math.max(1, Math.floor(Number(options.threshold) || 3))
  const cooldownMs = Math.max(10_000, Math.floor(Number(options.cooldownMs) || 600_000))
  const probeWindowMs = Math.max(30_000, Math.floor(Number(options.probeWindowMs) || 180_000))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const onChange = typeof options.onChange === 'function' ? options.onChange : null

  let state = normalize(options.state)

  function commit() {
    if (onChange === null) return
    try {
      onChange(exportState())
    } catch {
      /* 落盘失败不影响判决：熔断是保护，不是账本 */
    }
  }

  function exportState() {
    const out = {}
    for (const key of STATE_KEYS) out[key] = state[key]
    return out
  }

  /** 开闸中且冷却未过 ⇒ true（只读，不改状态）。 */
  function isOpen(at = now()) {
    if (state.openedAt === 0) return false
    return at - state.openedAt < cooldownMs
  }

  /** 还要等多久才允许试探（0 = 现在就可以）。 */
  function remainingMs(at = now()) {
    if (state.openedAt === 0) return 0
    return Math.max(0, cooldownMs - (at - state.openedAt))
  }

  /**
   * 这一条调用能不能放行。
   * 注意：冷却到期后的**第一次** `allow()` 会占用 half-open 的唯一名额（有副作用）。
   * 只想问"现在是不是在熔断里"请用 `isOpen()`。
   */
  function allow(at = now()) {
    if (state.openedAt === 0) return true
    if (at - state.openedAt < cooldownMs) return false
    if (state.probingAt > 0 && at - state.probingAt < probeWindowMs) return false
    state.probingAt = at
    commit()
    return true
  }

  /**
   * 记一次失败。
   * @param {{error?: string, chatKey?: string, turnMs?: number}} [info]
   * @returns {{opened: boolean, count: number, remainingMs: number}}
   *   `opened=true` 表示**这一次**刚好跨过阈值（调用方据此发通知，不要每回合都发）。
   */
  function fail(info = {}, at = now()) {
    const wasOpen = state.openedAt > 0
    state.failures += 1
    state.probingAt = 0
    state.lastAt = at
    if (typeof info.error === 'string' && info.error !== '') state.lastError = info.error.slice(0, 300)
    if (typeof info.chatKey === 'string' && info.chatKey !== '') state.lastChatKey = info.chatKey.slice(0, 80)
    if (Number.isFinite(info.turnMs) && info.turnMs > 0) state.lastTurnMs = Math.floor(info.turnMs)
    let opened = false
    if (state.failures >= threshold) {
      // 已经在 open 里又失败（half-open 试探失败）⇒ 冷却从这一次重新算，而不是沿用旧的。
      if (!wasOpen) state.opens += 1
      state.openedAt = at
      opened = !wasOpen
    }
    commit()
    return { opened, count: state.failures, remainingMs: remainingMs(at) }
  }

  /**
   * 记一次成功。
   * @returns {{recovered: boolean, count: number}} `recovered=true` 表示刚从熔断里恢复。
   */
  function ok(at = now()) {
    const wasOpen = state.openedAt > 0
    const count = state.failures
    state.failures = 0
    state.openedAt = 0
    state.probingAt = 0
    state.lastAt = at
    commit()
    return { recovered: wasOpen, count }
  }

  return {
    allow,
    isOpen,
    remainingMs,
    fail,
    ok,
    snapshot: exportState,
    /** 阈值与冷却（通知文案要用，避免桥里再抄一遍数字）。 */
    settings: { threshold, cooldownMs, probeWindowMs },
  }
}
