/**
 * 管理指令的**全分支**端到端（2026-11-16）
 *
 * 为什么需要它：`lib/admin-commands.js` 有 14 个分支、26 项端口，而 `smoke-run.mjs`
 * 只覆盖了 `!hush` 一个。**端口传错一项的后果不是报错，是那个命令静默失效** ——
 * 今天已经踩过一次（`debugLog` 裸引用，5 个套件同时红，但表现都是"命令没反应"）。
 *
 * ⚠️ 判据是**"代码有没有坏"，不是"业务成不成功"**：
 *   ✅ 通过 = 有回执 且 回执里**不含代码级异常**
 *   ❌ 失败 = 没回执 / 回执里有 `is not defined` / `Cannot read` / `TypeError` /
 *            `未知指令`（说明分发没接上）
 * 业务失败是**允许**的：`!groups` 没连 OneBot 会回"读不到群列表"，那是对的。
 * 把业务失败判成红，这个脚本就永远跑不绿，也就没人看了。
 *
 * 用法：`node test/admin-commands-e2e.mjs`（约 20 秒，不碰网络）
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'
import { OPTIONAL_GROUPS, REQUIRED, inspectAdapter } from '../lib/platform-adapter.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const replies = []

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  async sendSegments(socket, messageType, targetId, segments) {
    replies.push((segments ?? []).map((s) => s?.data?.text ?? '').join(''))
    return { message_id: replies.length }
  }
  async sendText(socket, messageType, targetId, text) {
    replies.push(String(text ?? ''))
    return { message_id: replies.length }
  }
  async callAction() { return { ok: true } }
  async getLoginInfo() { return { user_id: 3000000001, nickname: 'bot' } }
  async getStatus() { return { online: true } }
  async canSendImage() { return { yes: true } }
  async canSendRecord() { return { yes: true } }
  async getGroupList() { return { data: [{ group_id: 100000001, group_name: '测试群', member_count: 3 }] } }
  // 必需项之一：引用解析要用。第一版漏了它，最后那条契约断言立刻抓到 ——
  // 这也说明「契约检查」不是摆设，它会指出 mock 自己缺什么。
  async getMsg() { return null }
}

const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: {
    create: async ({ sessionId }) => ({
      agent: { id: String(sessionId), status: 'idle', followup: async () => {}, cancel() {} },
      sessionId: String(sessionId), dispose: async () => {},
    }),
    resume: async ({ resumeSessionId }) => ({
      agent: { id: String(resumeSessionId), status: 'idle', followup: async () => {}, cancel() {} },
      sessionId: String(resumeSessionId), dispose: async () => {},
    }),
  },
  fiber: null,
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  emit() {},
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [2000000001], allowGroups: [100000001],
  adminUsers: [2000000001],
  botQq: 3000000001, botName: 'bot', replyOnlyWhenMentioned: false, acceptPrivate: true,
  sessionMode: 'chat', sessionResumeEnabled: false, quietHours: [], quietHoursEnabled: false,
  traceEnabled: false, proactiveEnabled: false, adminEnabled: true, rateLimitEnabled: false,
  filterEnabled: false, visionMode: 'native', provider: 'test', model: 'test',
  mcStatusEnabled: false, momentImageMaxBytes: 5 * 1024 * 1024,
}

const root = mkdtempSync(join(tmpdir(), 'qq-admin-e2e-'))
const bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd: root }, new MockServer(), { info() {}, warn() {}, error() {} })
bridge.start()

const message = (text) => ({
  bot: null, userId: 2000000001, messageType: 'private', text,
  atMe: false, ats: [], reply: null,
  records: [], images: [], files: [], forwards: [], videos: [],
  messageId: `e2e-${Math.random().toString(36).slice(2)}`, senderName: '主人', raw: { message: [] },
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 代码级坏掉的标志（业务失败不算）。 */
const BROKEN = /is not defined|Cannot read|Cannot set|TypeError|ReferenceError|undefined is not a function|未知指令/

/**
 * 发一条管理指令，返回 { text, broken }。
 * @param {string} cmd 指令（含 `!`）
 * @param {number} waitMs
 */
async function run(cmd, waitMs = 900) {
  replies.length = 0
  bridge.server.emit('message', message(cmd))
  await sleep(waitMs)
  const text = replies.join(' | ')
  return { text, broken: BROKEN.test(text) || text.trim() === '' }
}

// 覆盖 14 个分支：顺序上 `hush` 先于 `wake`（后者要清掉前者），其余互不依赖
const CASES = [
  ['!hush 5', '静默'],
  ['!status', '会话/熔断/脱敏快照'],
  ['!model', '模型三行'],
  ['!canary', '金丝雀前 8 位'],
  ['!dlptest', 'DLP 自检 6 条'],
  ['!groups', '群列表'],
  ['!say 2000000001 你好', '直发一条'],
  ['!reopen u:2000000001', '重开会话'],
  ['!fav', '标一张喜欢的图'],
  ['!音色', '音色列表'],
  ['!试听 你好', '试听'],
  ['!唱 列表', '曲库列表'],
  ['!wake', '恢复主动通道'],
]

for (const [cmd, label] of CASES) {
  const { text, broken } = await run(cmd)
  check(`${cmd.padEnd(24)} ${label}`, !broken, broken ? JSON.stringify(text).slice(0, 120) : '')
}

// `!moment` 单独放最后：它会真的走 qzone 发布路径（这里连不上，必然失败），
// 但只要**不是代码级错误**就算通过 —— 它证明分支被路由到了、端口齐了。
{
  const { text, broken } = await run('!moment 自动化验收 --private', 2500)
  check('!moment 2000ms 内返回且不是代码错（发不出去是对的）', !broken, JSON.stringify(text).slice(0, 160))
}

// `!fav` 在没有图片时应该给出**人话**，不是空 —— 顺手钉一下
{
  replies.length = 0
  bridge.server.emit('message', message('!fav'))
  await sleep(900)
  const t = replies.join('')
  check('!fav 空图库时说人话（不是静默）', t.length > 0 && !/undefined/.test(t), JSON.stringify(t).slice(0, 80))
}

// 契约自检：这个 mock 只实现了必需项 + getGroupList，缺的可选能力应该被如实报出
{
  const info = inspectAdapter(bridge.server)
  check('mock 平台实现了必需 8 项（契约可被它满足）', info.ok, info.missing.join(','))
  const groupCount = Object.keys(info.groups).length
  check('mock 缺的可选能力被如实统计（不假装支持）', groupCount > 0, `缺 ${groupCount}/${Object.keys(OPTIONAL_GROUPS).length} 组`)
  check('必需项数量与契约一致', REQUIRED.length === 8)
}

try { bridge.stop() } catch {}
try { rmSync(root, { recursive: true, force: true }) } catch {}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
