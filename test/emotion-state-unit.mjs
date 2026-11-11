/**
 * 情绪状态：累积、衰减、封顶（2026-11-11）。
 *
 * 依据 `设计/七情六欲…§4.2/§4.3`：快层会衰减；任何情绪有界。
 * 锁四件事：
 *   ① 连续同一种情绪会累积（不是每轮重置）；
 *   ② 10 分钟半衰（时间过去强度减半）；
 *   ③ 封顶 1.0（不会无限涨）；
 *   ④ 低于 floor 自动清掉，dominant 返回最强的那一个。
 */
import { EmotionState } from '../lib/emotion-state.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const T0 = 1_700_000_000_000

// ① 累积
const s = new EmotionState({ now: T0 })
s.update('生气', 0.6, T0)
const v1 = s.snapshot().生气
s.update('生气', 0.6, T0)
const v2 = s.snapshot().生气
s.update('生气', 0.6, T0)
const v3 = s.snapshot().生气
check('连续三次会累积', v1 < v2 && v2 < v3, `${v1.toFixed(3)} → ${v2.toFixed(3)} → ${v3.toFixed(3)}`)
check('累积幅度合理（首次≈0.42）', Math.abs(v1 - 0.42) < 1e-9, String(v1))

// ② 衰减：10 分钟后减半
const d = new EmotionState({ now: T0 })
d.update('委屈', 0.8, T0)
const before = d.snapshot().委屈
const after = d.dominant(T0 + 10 * 60_000)?.intensity ?? 0
check('10 分钟减半', Math.abs(after - before / 2) < 1e-9, `${before.toFixed(3)} → ${after.toFixed(3)}`)

// ③ 封顶
const c = new EmotionState({ now: T0 })
for (let i = 0; i < 12; i++) c.update('害怕', 1, T0)
check('多次冲击不超过 1.0', c.snapshot().害怕 <= 1 + 1e-9, String(c.snapshot().害怕))

// ④ floor 清理 + dominant
const m = new EmotionState({ now: T0 })
m.update('开心', 0.9, T0)
m.update('委屈', 0.4, T0)
check('dominant 取最强', m.dominant(T0)?.emotion === '开心', JSON.stringify(m.dominant(T0)))
const far = m.dominant(T0 + 60 * 60_000)
check('一小时后全部衰减到 floor 以下 ⇒ null', far === null, JSON.stringify(far))
check('空状态 dominant 为 null', new EmotionState({ now: T0 }).dominant(T0) === null)

// ⑤ 空情绪名不写进状态
const n = new EmotionState({ now: T0 })
n.update('', 0.8, T0)
check('空情绪名被忽略', Object.keys(n.snapshot()).length === 0, JSON.stringify(n.snapshot()))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
