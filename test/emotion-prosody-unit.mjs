/**
 * 情绪 → 语音参数的**换算逻辑**（2026-11-10）。
 *
 * ⚠️ 这里用一张**假表**验证换算，不引用真实调参数值：
 * 真实表在 `data/emotions.json`（已被 .gitignore 排除，不随开源代码发布）。
 * 本测试要锁的是：
 *   ① 负向 ×1.2 / 正向 ×0.8（`七情六欲 §4.3` 第三条边界）；
 *   ② 强度 0→0.5 倍、1→1.5 倍；
 *   ③ volume 不随强度缩放；
 *   ④ 未知情绪返回 null（交给兜底）；
 *   ⑤ `[emotion=…]` / `[intensity=…]` 能被剥掉，不念出来。
 */
import { emotionToProsody, parseEmotionTags, EMOTION_PROSODY } from '../lib/tts.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// 假表：只用于验证换算，不代表真实调参
const TABLE = {
  正向: { v: 0.5, a: 0.5, rate: 4, pitch: 4, volume: 3 },
  负向: { v: -0.5, a: 0.5, rate: -4, pitch: 2, volume: -10 },
  中性: { v: 0, a: 0.2, rate: -2, pitch: 0, volume: -4 },
}
const p = (emotion, intensity) => emotionToProsody(emotion, intensity, TABLE)
const fmt = (x) => JSON.stringify(x)

// ① 符号不对称：正向 ×0.8、负向 ×1.2
const pos = p('正向', 0.6)
const neg = p('负向', 0.6)
const flat = p('中性', 0.6)
check('正向：幅度 ×0.8', pos.rate === '+4%' && pos.pitch === '+4Hz' && pos.volume === '+3%', fmt(pos))
check('负向：幅度 ×1.2', neg.rate === '-5%' && neg.pitch === '+3Hz' && neg.volume === '-10%', fmt(neg))
check('中性（v=0）：不乘符号系数', flat.rate === '-2%' && flat.pitch === '+0Hz' && flat.volume === '-4%', fmt(flat))

// ② 强度缩放：0 → 0.5 倍，1 → 1.5 倍
const low = p('正向', 0)
const high = p('正向', 1)
check('强度 0 = 幅度减半', low.rate === '+2%' && low.pitch === '+2Hz', fmt(low))
check('强度 1 = 幅度 1.5 倍', high.rate === '+5%' && high.pitch === '+5Hz', fmt(high))

// ③ volume 不随强度变
check('volume 不随强度缩放', low.volume === high.volume && low.volume === '+3%', `${low.volume}/${high.volume}`)

// ④ 未知情绪 → null
check('未知情绪返回 null', p('暴躁', 0.5) === null)
check('空情绪返回 null', p('', 0.5) === null)

// ⑤ 别名（机制的一部分，可公开；用带中文键的假表）
const ALIAS_TABLE = {
  撒娇: { v: 0.5, a: 0.5, rate: 1, pitch: 1, volume: 1 },
  开心: { v: 0.5, a: 0.5, rate: 1, pitch: 1, volume: 1 },
}
check('英文别名可用', emotionToProsody('coax', 0.6, ALIAS_TABLE)?.mood === '撒娇')
check('别名大小写不敏感', emotionToProsody('HAPPY', 0.6, ALIAS_TABLE)?.mood === '开心')

// 默认表：只验证"有表可查"，不断言具体数值（数值在私有文件里）
check('默认表非空', Object.keys(EMOTION_PROSODY).length > 0, String(Object.keys(EMOTION_PROSODY).length))

// ⑥ 标签解析
const t1 = parseEmotionTags('[emotion=撒娇]爸爸抱抱嘛')
check('解析：剥掉情绪标签', t1.text === '爸爸抱抱嘛' && t1.emotion === '撒娇' && t1.intensity === null, fmt(t1))
const t2 = parseEmotionTags('[emotion=coax][intensity=0.8] 想你了')
check('解析：情绪 + 强度', t2.emotion === 'coax' && t2.intensity === 0.8 && t2.text === '想你了', fmt(t2))
const t3 = parseEmotionTags('没有标签的一句话')
check('解析：无标签时原样返回', t3.emotion === '' && t3.intensity === null && t3.text === '没有标签的一句话', fmt(t3))
const t4 = parseEmotionTags('[emotion = 委屈 ] 你走吧')
check('解析：容忍空格', t4.emotion === '委屈' && t4.text === '你走吧', fmt(t4))
const t5 = parseEmotionTags('[emotion=困]')
check('解析：只有标签时正文为空', t5.text === '' && t5.emotion === '困', fmt(t5))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
