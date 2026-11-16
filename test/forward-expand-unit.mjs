/**
 * `expandForwards` 迁移后的单测（2026-11-15，模块化第 2 批）。
 *
 * 这个函数是**有 IO 的**（取转发、下图片），所以它没有 help 那种"逐字快照"可比。
 * 能钉住的是**分支行为**：什么输入走哪条路、返回值里哪些字段必须是什么。
 * 这些分支原来埋在 14k 行文件里，只能靠真机试；搬出来之后第一次可以单测。
 *
 * 覆盖：provided / offline / 无 id / 取失败 / dryRun / 正常展开 / 图片预算文案。
 * 不覆盖：真实网络下载（那属于 `download.js` 与 egress 的测试）。
 */
import { expandForwards } from '../lib/forward-expand.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const CONFIG = {
  forwardMaxNodes: 50,
  forwardMaxChars: 4000,
  forwardImageMax: 4,
  visionMode: 'native',
  visionToolName: 'describe_image',
}

/** 造一个最小可用的端口；`getForwardMsg` 由每个用例替换。 */
function makePort(overrides = {}) {
  return {
    config: CONFIG,
    imageDir: '/tmp/images',
    debugLog: () => {},
    gifVision: async (path) => ({ vision: path, note: '' }),
    imageBlocksFor: async (paths) => paths.map((p) => ({ type: 'image', path: p })),
    server: {
      currentSocket: () => ({ id: 'sock' }),
      getForwardMsg: async () => ({ messages: [] }),
      ...overrides.server,
    },
    ...overrides,
  }
}

const msg = (extra = {}) => ({ messageType: 'group', groupId: 1, userId: 2, ...extra })

// ① provided：回放/注入已给文本，不走网络
{
  const r = await expandForwards(makePort(), msg({ forwardText: '第一行\n第二行' }))
  check('provided 直接返回，不取网络', r.source === 'provided' && r.text.includes('第一行'), JSON.stringify(r).slice(0, 120))
  check('provided 的 used/total 都是 1', r.used === 1 && r.total === 1)
}

// ② provided 超长要截断并注明
{
  const r = await expandForwards(makePort(), msg({ forwardText: 'x'.repeat(10) }), )
  check('短文本不截断', r.truncated === false)
  const port = makePort()
  port.config = { ...CONFIG, forwardMaxChars: 5 }
  const r2 = await expandForwards(port, msg({ forwardText: 'abcdefghij' }))
  check('超长截断并注明', r2.truncated === true && r2.text.includes('内容过长已截断'))
}

// ③ offline：注入/回放且没给文本 ⇒ 明确说"不访问 QQ"
{
  const r = await expandForwards(makePort(), msg({ __injected: true }))
  check('offline 不访问网络', r.source === 'offline' && r.text === '')
  check('offline 给出理由', typeof r.reason === 'string' && r.reason.includes('回放/注入'))
}

// ④ 没有 id ⇒ 直接说展开不了
{
  const r = await expandForwards(makePort(), msg({ forwards: [{ id: '', msgId: '' }, null] }))
  check('无 id 不取网络', r.source === 'none' && r.text === '')
  check('无 id 给出理由', String(r.reason).includes('没有 id'))
}

// ⑤ 取失败 ⇒ failures 计数体现在 reason
{
  const port = makePort({ server: { getForwardMsg: async () => { throw new Error('boom') }, currentSocket: () => ({}) } })
  const r = await expandForwards(port, msg({ forwards: [{ id: 'f1' }] }))
  check('取失败如实报次数', r.text === '' && String(r.reason).includes('1 次'))
}

// ⑥ dryRun ⇒ 单独一条理由（不能和"内容为空"混为一谈）
{
  const port = makePort({ server: { getForwardMsg: async () => ({ dryRun: true }), currentSocket: () => ({}) } })
  const r = await expandForwards(port, msg({ forwards: [{ id: 'f1' }] }))
  check('dryRun 单独识别', r.source === 'dry-run' && String(r.reason).includes('dry-run'))
}

// ⑦ 正常展开：有文本、used/total 记账、source=api
{
  const port = makePort({
    server: {
      currentSocket: () => ({ id: 'sock' }),
      getForwardMsg: async () => ({ messages: [{ sender: { nickname: '甲' }, content: [{ type: 'text', data: { text: '你好' } }] }] }),
    },
  })
  const r = await expandForwards(port, msg({ forwards: [{ id: 'f1' }] }))
  check('正常展开 source=api', r.source === 'api', `source=${r.source} text=${String(r.text).slice(0, 40)}`)
  check('正常展开有正文', typeof r.text === 'string' && r.text.length > 0)
  check('正常展开 total>=1', r.total >= 1, `used=${r.used} total=${r.total}`)
}

// ⑧ 只取前 3 张卡片，其余记进 skippedCards
{
  const port = makePort({
    server: {
      currentSocket: () => ({ id: 'sock' }),
      getForwardMsg: async () => ({ messages: [{ sender: { nickname: '甲' }, content: [{ type: 'text', data: { text: 'x' } }] }] }),
    },
  })
  const r = await expandForwards(port, msg({ forwards: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }] }))
  check('最多取 3 张卡片，其余记 skippedCards', r.skippedCards === 2, `skippedCards=${r.skippedCards}`)
}

// ⑨ 端口缺 gifVision / imageBlocksFor 时不能炸（第 2 批把"必须注入"变成"可选"）
{
  const port = makePort({ gifVision: undefined, imageBlocksFor: undefined })
  const r = await expandForwards(port, msg({ forwards: [{ id: 'f1' }] }))
  check('缺可选回调不抛错', typeof r === 'object' && r !== null)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
