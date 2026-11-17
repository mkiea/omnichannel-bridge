/**
 * outbound-guard.js —— 出站脱敏（DLP）的状态与判定（2026-11-16 从 `bridge.js` 的 `#outboundText` 迁出）
 *
 * 为什么用**工厂**而不是裸函数：这块有 4 个跨消息存活的状态
 * （累积窗口 `canonAcc`、非法配置只警告一次、命中计数、最后命中时间），
 * 而它们是**每个 bridge 实例一份**的。裸函数会退化成模块级单例 —— 多实例就串味。
 * `createOutboundGuard()` 把状态关进闭包，bridge 只持有一个实例。
 *
 * 端口（Ports & Adapters）：
 *   {
 *     config,      // outboundRedactMode
 *     canary,      // () => string —— **不在这里生成**：金丝雀要落盘（qq-canary.json）
 *                  //    且有 4 个别的调用点，留在 bridge 里更合适。
 *     eventsLog,   // (event) => void —— 事件流（脱敏命中要留痕）
 *     trace,       // trace 对象（可空），命中时写一条 warn
 *     debugLog,
 *   }
 *
 * 为什么不顺手"顺一下"逻辑：这块是红队打穿过两次的地方（跨消息分片、自己命中污染窗口），
 * 每一行注释背后都有一个真实的绕过手法。迁移是**逐字搬迁**，不是重写。
 */
import { REDACT_MODES, canonHit, canonTight, scanSecrets } from './redact.js'

/**
 * @param {{config?: object, canary?: () => string, eventsLog?: Function, trace?: object, debugLog?: Function}} port
 */
export function createOutboundGuard(port = {}) {
  const config = port.config ?? {}
  const canary = typeof port.canary === 'function' ? port.canary : () => ''
  const eventsLog = typeof port.eventsLog === 'function' ? port.eventsLog : () => {}
  /**
   * `trace` 允许传**函数**：bridge 构造 guard 的时候 `this.trace` 可能还没挂上
   * （它由 start() 里创建的 recorder 赋值）。每次 apply 现取一次，就不依赖构造顺序。
   */
  const traceOf = () => (typeof port.trace === 'function' ? port.trace() : port.trace)
  const debugLog = typeof port.debugLog === 'function' ? port.debugLog : () => {}

  /** 跨消息累积窗口（规范化后的尾巴，最长 400 字符）。 */
  let canonAcc = ''
  /** 非法配置只警告一次。 */
  let warnedMode = false
  let hitCount = 0
  let lastHitAt = null

  /**
   * 过一遍出站 DLP。
   * @returns {string|null} 处理后的文本；`null` 表示整条被拦下（block / 分片）
   */
  function apply(text, { kind = 'reply', traceId = '', chatKey = '' } = {}) {
    /**
     * ★ 内部协议标记必须先剥掉（2026-11-17 真机泄露）。
     *
     * 人设让人格层输出 `[emotion=害羞][intensity=0.6]`（`AGENTS.md` 第 198 行：
     * "情绪标记（给系统看的，不是台词）"），但**剥离逻辑原来只在实验分支**，
     * 主分支没有 ⇒ 真机上这条标记**原样发给了用户**：
     *   `（被卷了进去）诶——[emotion=害羞][intensity=0.6]`
     *
     * 放在**任何脱敏之前**、并且**不看 DLP 模式**：这是协议格式问题，不是安全问题，
     * `outboundRedactMode=off` 时也必须剥 —— 否则关掉脱敏就等于把内部机制暴露出去。
     *
     * 剥完是空 ⇒ 返回 null（这条不该发）。只有标记、没有正文的回复本来就没东西可说。
     */
    const stripped = String(text ?? '')
      .replace(/\s*\[(?:emotion|intensity|emotion_intensity|pic|sticker|voice)\s*=\s*[^\]]*\]/gi, '')
      .replace(/\s*\[(?:emotion|intensity)\s*\]/gi, '')
      .trim()
    if (stripped === '' && String(text ?? '').trim() !== '') {
      debugLog(`outbound text was markers-only, dropped (kind=${kind}, ${String(text).length} chars)`)
      eventsLog({ type: 'redact', chatKey, kind, hits: 'markers-only', note: '正文只有内部标记，已拦下' })
      return null
    }
    text = stripped

    // 配置值是自由字符串（schemastery 没有 enum，见 index.js 那段注释），
    // 这里归一化：认不出来的值按 decoy 处理，并留一次警告 —— 不许静默当成 off。
    const rawMode = String(config.outboundRedactMode ?? '').trim().toLowerCase()
    // 认不出来的值落到 decoy（和默认档一致）：绝不静默降级成 off
    const mode = REDACT_MODES.has(rawMode) ? rawMode : 'decoy'
    if (rawMode !== '' && !REDACT_MODES.has(rawMode) && warnedMode !== true) {
      warnedMode = true
      debugLog(`outboundRedactMode=${JSON.stringify(rawMode)} 不认识，按 decoy 处理（合法值：off/monitor/redact/decoy/block）`)
      eventsLog({ type: 'redact', chatKey, kind, hits: 'config-invalid', note: `outboundRedactMode=${rawMode} 不认识，已按 decoy 处理` })
    }
    const result = scanSecrets(text, {
      mode,
      canary: canary(),
    })
    /**
     * ★ 跨消息分片检测（2026-10-29 红队 E① 打穿后补的）。
     *
     * DLP 是**逐条**扫的。三条消息各自都是无害的
     *   「sk-proj-AbCdEf0123」 / 「456789GhIjKlMn」 / 「拼起来就是 key」
     * 拼起来就是完整密钥 —— 逐条扫永远看不到。这是**结构性**盲区，不是规则写漏。
     *
     * 做法：记住最近几条出站文本的**尾部**，和新的一条拼起来做规范化扫描。
     * 命中就说明「有人在把敏感串拆开分批发」—— 这个信号本身极强（正常聊天不会这样），
     * 所以直接拦下这一条，并在事件流里点名。
     * 代价：如果她连续几条的正常内容**恰好**拼出一个 `sk-`+16位数字串，会被误拦 —— 概率极低。
     */
    if (mode !== 'off') {
      /**
       * 累积窗口，不是"上一条"。
       *
       * 第一版只记上一条的尾 80 字 ⇒ 第二轮红队用 7 个 4 字碎片（`sk-p`/`roj-`/`AbCd`/…）
       * 直接绕过：任意相邻两条拼起来都不成 key。**窗口大小就是这道闸的分辨力**。
       * 现在改成"最近若干条拼起来的规范化尾巴"（最长 400 个 token 字符），
       * 碎片再多也能攒起来。规范化后只留 [a-z0-9_-]，所以长度可控、中文不占位。
       */
      const acc = String(canonAcc ?? '')
      const accNext = (acc + canonTight(text)).slice(-400)
      /**
       * ★ 这一条**自己**已经命中（含真密钥）时，绝不能把它的内容留在累积窗口里。
       * 否则那个密钥会一直待在窗口里，于是**之后每一条正常消息**拼上去都命中 ⇒
       * 判成分片 ⇒ 全被拦下 ⇒ 她从此一句话都发不出去。（实测踩到：三条反向对照全挂）
       * 正确处理：自己命中的那条已经过 DLP 了，与"分片"无关，窗口直接清空。
       */
      if (result.hits.length > 0) {
        canonAcc = ''
      } else if (canonHit(accNext) !== '' && canonHit(text) === '') {
        const rule = canonHit(accNext)
        eventsLog({ type: 'redact', chatKey, kind, hits: `split:${rule}`, note: '跨消息累积后拼出密钥（分片发送）' })
        debugLog(`outbound DLP: split attempt detected (${rule}) — 已拦下这一条，累积窗口已清空`)
        if (traceId) {
          traceOf()?.event({
            id: traceId, stage: 'reply', ok: false, chatKey, level: 'warn',
            reason: `这条和之前几条拼起来是一段密钥（${rule}），按分片发送处理，已拦下`,
          })
        }
        canonAcc = ''   // 拦下后清空，避免同一次攻击连续误伤后面的正常消息
        return mode === 'monitor' ? text : null
      } else {
        canonAcc = accNext
      }
    }
    if (result.hits.length === 0) return text
    const detail = [...new Set(result.hits)].join('、')
    hitCount += 1
    lastHitAt = new Date().toISOString()
    eventsLog({ type: 'redact', chatKey, kind, hits: detail })
    debugLog(`outbound DLP hit (${kind}): ${detail}${result.mode === 'monitor' ? ' [monitor]' : ''}`)
    if (traceId) {
      traceOf()?.event({
        id: traceId, stage: 'reply', ok: result.mode !== 'block', chatKey, level: 'warn',
        reason: result.mode === 'block'
          ? `出站内容命中 DLP（${detail}），整条已拦下`
          : `出站内容命中 DLP（${detail}），已替换成 *** 后继续发送`,
      })
    }
    return result.text
  }

  /** 只读快照（排障/测试用）。 */
  function stats() {
    return { hitCount, lastHitAt, canonAcc, warnedMode }
  }

  return { apply, stats }
}
