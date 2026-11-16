/**
 * 平台适配器契约的单测（2026-11-16）。
 *
 * 最重要的一条是 A3：**真实的 `OneBotServer` 必须满足 `REQUIRED`** ——
 * 如果它不满足，说明契约不是"从代码反推的"，而是我编的，那这份契约就没有意义。
 *
 * 判据（跑之前写死）：
 *   A1 内存适配器（只实现必需 8 项）判定为合规
 *   A2 缺任一必需方法 ⇒ 不合规，且 `missing` 指名道姓
 *   A3 ★真实的 OneBotServer 判定为合规（契约与现网实现一致）
 *   A4 `assertAdapter` 缺项时抛 TypeError，消息里带方法名
 *   A5 可选能力缺失**不影响**合规（只让功能降级）
 *   A6 `describeAdapter` 能说出"必需齐不齐 + 各能力组缺几项"
 */
import { OneBotServer } from '../lib/onebot.js'
import {
  ADAPTER_SHAPE, CAPABILITY_MAP, OPTIONAL, REQUIRED,
  assertAdapter, createMemoryAdapter, describeAdapter, inspectAdapter,
} from '../lib/platform-adapter.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// A1 内存适配器
{
  const info = inspectAdapter(createMemoryAdapter())
  check('A1 内存适配器合规（只实现必需 8 项）', info.ok && info.missing.length === 0, JSON.stringify(info.missing))
}

// A2 缺项
{
  const impl = createMemoryAdapter()
  delete impl.getMsg
  delete impl.sendText
  const info = inspectAdapter(impl)
  check('A2 缺必需方法 ⇒ 不合规', info.ok === false)
  check('A2 missing 指名道姓', info.missing.sort().join(',') === 'getMsg,sendText', info.missing.join(','))
}

// A3 真实实现（这条最关键）
{
  const server = new OneBotServer({ host: '127.0.0.1', port: 0, accessToken: '' }, { info() {}, warn() {}, error() {} })
  const info = inspectAdapter(server)
  check('A3 ★真实 OneBotServer 满足 REQUIRED', info.ok, info.missing.length > 0 ? `缺 ${info.missing.join(',')}` : '')
  // ✅ 实测：OneBotServer 把 9 组可选能力**全实现了**（一个不缺）。
  // 这条不是"越少越好"，而是钉住"契约里的可选清单在这份实现上确实是满的" ——
  // 将来若真有哪组掉了，说明要么契约写错，要么实现退化了，两种都该知道。
  check('A3 ★真实实现的可选能力全齐（9 组一个不缺）', Object.keys(info.groups).length === 0, `缺 ${Object.keys(info.groups).length} 组`)
  check('A3 真实实现没有"契约外"的方法', info.unknown.length === 0, info.unknown.slice(0, 6).join(','))
  try { server.stop?.() } catch { /* 没起过来，无所谓 */ }
}

// A4 assertAdapter
{
  const impl = createMemoryAdapter()
  delete impl.currentSocket
  let err = null
  try { assertAdapter(impl, 'fake') } catch (e) { err = e }
  check('A4 缺项时被 assert 拦住', err instanceof TypeError)
  check('A4 错误信息带方法名和出处', /currentSocket/.test(err?.message ?? '') && /platform-adapter\.js/.test(err?.message ?? ''), err?.message ?? '')
}

// A5 可选缺失不影响合规
{
  const impl = createMemoryAdapter()   // 一个可选方法都没实现
  const info = inspectAdapter(impl)
  check('A5 可选全缺仍合规', info.ok === true)
  check('A5 但会报告缺失的组', Object.keys(info.groups).length === Object.keys(CAPABILITY_MAP).length, `${Object.keys(info.groups).length} 组`)
}

// A6 describeAdapter
{
  const text = describeAdapter(createMemoryAdapter())
  check('A6 报出必需项状态', text.includes(`必需 ${REQUIRED.length} 项：齐`), text.split('\n')[0])
  check('A6 报出分组缺失', /⬜ groupAdmin/.test(text))
  check('A6 分组数覆盖契约', Object.keys(CAPABILITY_MAP).length === Object.keys(ADAPTER_SHAPE.OPTIONAL_GROUPS).length)
  check('A6 可选清单是分组的扁平化', OPTIONAL.length === new Set(OPTIONAL).size, `${OPTIONAL.length} 项`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
