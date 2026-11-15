/**
 * 回合熔断闸的单测（2026-11-15）。
 *
 * 钉住的是**判决边界**，不是实现细节：
 *   · 没到阈值不许拦（单次抖动该给重试机会，闸不能变成"一报错就闭嘴"）；
 *   · 到了阈值必须拦，而且拦的时候要把剩余冷却算准（通知文案要用）；
 *   · 冷却到期只放**一条**（否则恢复瞬间所有积压消息一起涌进去，等于没熔断）；
 *   · 半开成功要能恢复、半开失败要立刻重新计时（否则"坏着但一直放行"）；
 *   · 落盘往返、损坏状态、clock 倒退都不能让闸卡死（宁可放行，不可永久闭锁）。
 */
import { createTurnBreaker } from '../lib/circuit-breaker.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

/** 可控时钟：单测不该真的等 10 分钟。 */
function clockAt(start = 1_000_000) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms; return t }
  return now
}

// ── ① 初始状态：closed，放行 ────────────────────────────────────────────────
{
  const b = createTurnBreaker({ threshold: 3, cooldownMs: 600_000, now: clockAt() })
  check('初始放行', b.allow() === true)
  check('初始未开闸', b.isOpen() === false)
  check('初始剩余 0', b.remainingMs() === 0)
}

// ── ② 两次失败不够（阈值 3），仍然放行 ──────────────────────────────────────
{
  const now = clockAt()
  const b = createTurnBreaker({ threshold: 3, cooldownMs: 600_000, now })
  b.fail({ error: 'e1' })
  b.fail({ error: 'e2' })
  check('未达阈值仍放行', b.allow() === true, `failures=${b.snapshot().failures}`)
  check('未达阈值不算开闸', b.isOpen() === false)
}

// ── ③ 第三次失败 ⇒ 开闸，且只在跨阈值那次报 opened ─────────────────────────
{
  const now = clockAt()
  const b = createTurnBreaker({ threshold: 3, cooldownMs: 600_000, now })
  b.fail({ error: 'e1' })
  b.fail({ error: 'e2' })
  const r3 = b.fail({ error: 'transport failed', chatKey: 'u:1001', turnMs: 25_866 })
  check('第三次失败开闸', r3.opened === true, JSON.stringify(r3))
  check('开闸后不放行', b.allow() === false)
  check('开闸后 isOpen', b.isOpen() === true)
  check('剩余冷却 = 600s', b.remainingMs() === 600_000, String(b.remainingMs()))
  check('记下了最后错误', b.snapshot().lastError === 'transport failed')
  check('记下了会话与耗时',
    b.snapshot().lastChatKey === 'u:1001' && b.snapshot().lastTurnMs === 25_866)
  const r4 = b.fail({ error: 'again' })
  check('开闸后再失败不重复报 opened', r4.opened === false, JSON.stringify(r4))
  check('opens 只加一次', b.snapshot().opens === 1, String(b.snapshot().opens))
}

// ── ④ 冷却未到：不放行，剩余时间随时钟递减 ───────────────────────────────────
{
  const now = clockAt()
  const b = createTurnBreaker({ threshold: 1, cooldownMs: 600_000, now })
  b.fail({ error: 'e' })
  now.advance(299_000)
  check('冷却中不放行', b.allow() === false)
  check('剩余 301s', b.remainingMs() === 301_000, String(b.remainingMs()))
  now.advance(301_000)
  check('到点放行', b.allow() === true)
}

// ── ⑤ half-open 只放一条 ────────────────────────────────────────────────────
{
  const now = clockAt()
  const b = createTurnBreaker({ threshold: 1, cooldownMs: 600_000, probeWindowMs: 180_000, now })
  b.fail({ error: 'e' })
  now.advance(600_000)
  check('冷却到期后第一条放行', b.allow() === true)
  check('同一窗口内第二条不放行', b.allow() === false)
  now.advance(180_000)
  check('试探窗口过后再放一条', b.allow() === true)
}

// ── ⑥ 半开成功 ⇒ 恢复，且通知只需一次 ──────────────────────────────────────
{
  const now = clockAt()
  const b = createTurnBreaker({ threshold: 2, cooldownMs: 600_000, now })
  b.fail({})
  b.fail({})
  now.advance(600_000)
  b.allow()
  const r = b.ok()
  check('半开成功 ⇒ recovered', r.recovered === true, JSON.stringify(r))
  check('恢复后 isOpen=false', b.isOpen() === false)
  check('恢复后放行', b.allow() === true)
  check('恢复后失败计数清零', b.snapshot().failures === 0)
  const r2 = b.ok()
  check('正常回合不重复报 recovered', r2.recovered === false)
}

// ── ⑦ 半开又失败 ⇒ 立刻重新开闸，冷却从这次重算 ────────────────────────────
{
  const now = clockAt()
  const b = createTurnBreaker({ threshold: 2, cooldownMs: 600_000, now })
  b.fail({})
  b.fail({})
  now.advance(600_000)
  check('半开放一条', b.allow() === true)
  const r = b.fail({ error: 'still broken' })
  check('半开失败不重复报 opened', r.opened === false, JSON.stringify(r))
  check('半开失败重新闭锁', b.isOpen() === true)
  check('冷却从这次重算（整 600s）', b.remainingMs() === 600_000, String(b.remainingMs()))
  check('重新闭锁后不放行', b.allow() === false)
}

// ── ⑧ 落盘往返：状态能接着用 ────────────────────────────────────────────────
{
  const now = clockAt()
  const b1 = createTurnBreaker({ threshold: 2, cooldownMs: 600_000, now })
  b1.fail({ error: 'x' })
  b1.fail({ error: 'x' })
  const saved = b1.snapshot()
  const b2 = createTurnBreaker({ threshold: 2, cooldownMs: 600_000, now, state: saved })
  check('落盘后仍是开闸态', b2.isOpen() === true)
  check('落盘后不放行', b2.allow() === false)
  const b3 = createTurnBreaker({ threshold: 2, cooldownMs: 600_000, now, state: JSON.parse(JSON.stringify(saved)) })
  now.advance(600_000)
  check('落盘态到期后照样能放行', b3.allow() === true)
}

// ── ⑨ 损坏状态一律当 closed（宁可放行，不可永久闭锁）──────────────────────
{
  const now = clockAt()
  const bad = [
    null, undefined, 'oops', 42,
    { failures: 0, openedAt: 123 },          // 自相矛盾：没失败却挂着打开时刻
    { failures: 'x', openedAt: -5 },          // 类型/负值都不合法
  ]
  let allClosed = true
  for (const state of bad) {
    const b = createTurnBreaker({ threshold: 1, cooldownMs: 600_000, now, state })
    if (b.isOpen() || b.allow() !== true) allClosed = false
  }
  check('损坏状态当 closed', allClosed)
}

// ── ⑩ onChange 抛错不影响判决（熔断是保护，不是账本）────────────────────────
{
  const now = clockAt()
  let calls = 0
  const b = createTurnBreaker({
    threshold: 1, cooldownMs: 600_000, now,
    onChange: () => { calls += 1; throw new Error('disk full') },
  })
  const r = b.fail({ error: 'e' })
  check('onChange 抛错仍然开闸', r.opened === true && b.isOpen() === true, `calls=${calls}`)
}

// ── ⑪ 时钟倒退不能把闸卡死 ────────────────────────────────────────────────
{
  const now = clockAt(2_000_000)
  const b = createTurnBreaker({ threshold: 1, cooldownMs: 600_000, now })
  b.fail({ error: 'e' })
  now.advance(-3_600_000)   // 系统时间被往回调
  check('时钟倒退仍判为冷却中（保守）', b.isOpen() === true)
  check('时钟倒退时剩余时间不为负', b.remainingMs() >= 0, String(b.remainingMs()))
}

// ── ⑫ 阈值 = 1 的边界：一次失败就拦 ────────────────────────────────────────
{
  const now = clockAt()
  const b = createTurnBreaker({ threshold: 1, cooldownMs: 60_000, now })
  const r = b.fail({ error: 'first' })
  check('阈值 1 一次就开闸', r.opened === true && b.allow() === false)
}

// ── ⑬ 阈值参数非法时回落到 3（不让配置写崩把闸变成一次性）──────────────────
{
  const now = clockAt()
  const b = createTurnBreaker({ threshold: 0, cooldownMs: 600_000, now })
  b.fail({})
  b.fail({})
  check('threshold=0 回落成 3（两次失败仍放行）', b.allow() === true)
  b.fail({})
  check('第三次失败才拦', b.allow() === false)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
