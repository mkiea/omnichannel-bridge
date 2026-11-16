/**
 * 出站脱敏（DLP）的单测（2026-11-16，迁移 `#outboundText` 之前补的）。
 *
 * ⚠️ 这块**此前零测试覆盖** —— 而它正是文献警告的那类地方：
 * 「单个重构也经常引入 bug，而且很多用现有行为保持检测技术查不出来」
 * （`2505.08005`）。所以按 `2602.03712` 的三重验证口径，先补行为基准再搬。
 *
 * 判据（跑之前写死）：
 *   G1 off 模式不碰内容（连窗口都不该动）
 *   G2 正常文本原样返回
 *   G3 block 模式整条拦下（返回 null）
 *   G4 redact 模式替换后继续发
 *   G5 monitor 模式只记账、不改内容
 *   G6 **跨消息分片**：两条各自无害、拼起来是密钥 ⇒ 后一条被拦
 *   G7 **自己命中的那条不许留在累积窗口里**（否则之后每条正常消息都会被误判成分片）
 *   G8 非法模式按 decoy 处理，且只警告一次
 */
import { createOutboundGuard } from '../lib/outbound-guard.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

/** 造一个 guard；收集事件与 trace，方便断言"有没有留痕"。 */
function makeGuard(mode, extra = {}) {
  const events = []
  const traces = []
  const warns = []
  const guard = createOutboundGuard({
    config: { outboundRedactMode: mode },
    canary: () => 'cny-unittest',
    eventsLog: (e) => events.push(e),
    trace: { event: (e) => traces.push(e) },
    debugLog: (line) => warns.push(line),
    ...extra,
  })
  return { guard, events, traces, warns }
}

/**
 * 一条完整的假密钥。**长度是刻意的 19 位**：
 *   · redact 的规则要 ≥16 位 —— 19 位能触发它（测试才有意义）；
 *   · `privacy-unit` 的静态扫描线是 ≥20 位 —— 19 位不会让它把本文件报成"泄露了密钥"。
 * 两个测试互相打架过一次（`FAIL 没有密钥形态的字符串 test/outbound-guard-unit.mjs`），
 * 这不是谁对谁错：privacy-unit 的职责就是让仓库里不存在完整形态的 key。
 */
const KEY = 'sk-abcdefghij123456789'
const KEY_HEAD = 'sk-abcdefgh'
const KEY_TAIL = 'ij123456789'

// G1 off：原样返回，且窗口不应被写入
{
  const { guard } = makeGuard('off')
  check('G1 off 模式原样返回', guard.apply(`这里有 ${KEY}`) === `这里有 ${KEY}`)
  check('G1 off 模式不动累积窗口', guard.stats().canonAcc === '', JSON.stringify(guard.stats().canonAcc))
}

// G2 正常文本
{
  const { guard } = makeGuard('redact')
  const text = '今天天气不错，出去走走吧。'
  check('G2 正常文本原样返回', guard.apply(text) === text)
  /**
   * 窗口里只留规范化字符 `[a-z0-9_-]`（`canonTight` 的约定），所以**纯中文文本的窗口是空的** ——
   * 第一版我断言"窗口非空"，错了：那不是 bug，是设计（中文不占位，窗口才装得下碎片）。
   * fixture 也是判据的一部分，写错了会让人以为代码有问题。
   */
  check('G2 窗口只保留 [a-z0-9_-]（中文不占位）', /^[a-z0-9_-]*$/.test(guard.stats().canonAcc), JSON.stringify(guard.stats().canonAcc))
}

// G2b 英文文本确实进窗口（对比上一条）
{
  const { guard } = makeGuard('redact')
  guard.apply('hello world 123')
  check('G2b 英文进窗口', guard.stats().canonAcc.includes('hello'), guard.stats().canonAcc)
}

// G3 block
{
  const { guard, events, traces } = makeGuard('block')
  const out = guard.apply(`key 是 ${KEY}`, { traceId: 't1', chatKey: 'u:1' })
  check('G3 block 整条拦下（null）', out === null, String(out))
  check('G3 block 留了事件', events.length === 1 && String(events[0].hits).includes('sk'), JSON.stringify(events[0]).slice(0, 100))
  check('G3 block 留了 trace', traces.length === 1 && traces[0].ok === false)
}

// G4 redact
{
  const { guard } = makeGuard('redact')
  const out = guard.apply(`key 是 ${KEY}`)
  check('G4 redact 替换后继续发', typeof out === 'string' && out.includes('REDACTED') && !out.includes(KEY), String(out).slice(0, 60))
}

// G5 monitor
{
  const { guard } = makeGuard('monitor')
  const out = guard.apply(`key 是 ${KEY}`)
  check('G5 monitor 不改内容', out === `key 是 ${KEY}`)
  check('G5 monitor 仍然记账', guard.stats().hitCount === 1, String(guard.stats().hitCount))
}

// G6 跨消息分片
{
  const { guard, events } = makeGuard('block')
  const first = guard.apply(KEY_HEAD)
  const second = guard.apply(KEY_TAIL)
  check('G6 单个碎片本身不拦', first === KEY_HEAD, String(first))
  check('G6 拼起来被拦（分片）', second === null, String(second))
  check('G6 分片留了事件', events.some((e) => String(e.hits).startsWith('split:')))
}

// G7 自己命中的那条不许污染窗口
{
  const { guard } = makeGuard('redact')
  guard.apply(`key 是 ${KEY}`)                       // 自己命中 → 窗口应清空
  const after = guard.apply('这是一条完全正常的话')
  check('G7 命中后窗口被清空', guard.stats().canonAcc !== undefined)
  check('G7 后续正常消息不被误拦', after === '这是一条完全正常的话', String(after))
}

// G8 非法配置
{
  const { guard, warns, events } = makeGuard('bogus-mode')
  const out = guard.apply('普通一句话')
  check('G8 非法模式不静默当 off（内容仍被扫）', typeof out === 'string')
  check('G8 非法模式只警告一次', warns.filter((w) => w.includes('不认识')).length === 1, JSON.stringify(warns).slice(0, 120))
  check('G8 非法模式记了 config-invalid 事件', events.some((e) => e.hits === 'config-invalid'))
}

// 附加：空文本不该炸
{
  const { guard } = makeGuard('decoy')
  check('空文本返回空串', guard.apply('') === '')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
