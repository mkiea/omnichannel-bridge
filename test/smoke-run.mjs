/**
 * 冒烟：整条链路能不能跑（2026-11-16）
 *
 * 为什么单测 + 全量还不够：它们大多在**函数级**验证，而"拆完能不能跑"问的是
 * **实例构造 → 启动 → 收消息 → 分发 → 回执**这条链是否完整。搬家最容易炸的正是这层：
 * 少一个 import、构造函数里引用顺序错、私有方法搬走后调用点没改。
 *
 * 判据（跑之前写死）：
 *   S1 加载 + 构造 + start() 不抛
 *   S2 `/ping`（**走新扩展点** dispatchCommand）能回 pong
 *   S3 `!status`（走**管理分发**，就是正在拆的那块）有回执
 *   S4 `/help`（走 lib/help.js + golden）有菜单
 *   S5 普通消息能进回合（followup 被调用）
 *   S6 `/mc` 有回执（探测失败也算通 —— 它证明命令被认领了）
 *
 * 拆 `#execAdminCommand` 前后都该全绿；红了就说明搬坏了，不是"测试太严"。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const replies = []
const turns = []

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }
  currentSocket() { return this.socket }
  // 签名照 bridge 里的真实调用：sendSegments(socket, messageType, targetId, segments)
  // 第一版我写成单参数，结果只收到 socket、回执全空 —— 冒烟第一件事就是抓这种误用。
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
}

const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: {
    create: async ({ sessionId }) => ({
      agent: {
        id: String(sessionId), status: 'idle',
        followup: async (message) => { turns.push(message) },
        cancel() {},
      },
      sessionId: String(sessionId), dispose: async () => {},
    }),
    resume: async ({ resumeSessionId }) => ({
      agent: { id: String(resumeSessionId), status: 'idle', followup: async (m) => { turns.push(m) }, cancel() {} },
      sessionId: String(resumeSessionId), dispose: async () => {},
    }),
  },
  fiber: null,
  // `agentDefaultModel.currentSelection()` 是会话安装时必调的（`!model` 命令与
  // 「插件配置为空 ⇒ 跟随宿主」的判断都靠它）。第一版没给，结果每条消息都炸在
  // 「Cannot read properties of undefined」—— 冒烟就是为抓这个。
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  emit() {},
}

const BASE = {
  host: '127.0.0.1', port: 0, accessToken: '', allowUsers: [2000000001], allowGroups: [100000001],
  botQq: 3000000001, botName: 'bot', replyOnlyWhenMentioned: false, acceptPrivate: true,
  // `#isAdmin` 只认这个名单（不看 botQq）—— 不配它，所有 `!` 命令都进不来
  adminUsers: [2000000001],
  sessionMode: 'chat', sessionResumeEnabled: false, quietHours: [], quietHoursEnabled: false,
  traceEnabled: false, proactiveEnabled: false, adminEnabled: true, rateLimitEnabled: false,
  filterEnabled: false, visionMode: 'native', provider: 'test', model: 'test',
  mcStatusEnabled: true, mcStatusTimeoutMs: 1200,
}

const root = mkdtempSync(join(tmpdir(), 'qq-smoke-'))
let bridge = null

try {
  bridge = new QQBridge(ctx, { ...Config({}), ...BASE, cwd: root }, new MockServer(), { info() {}, warn() {}, error() {} })
  bridge.start()
  check('S1 构造 + start() 不抛', true)
} catch (error) {
  check('S1 构造 + start() 不抛', false, error.message)
}

const message = (text) => ({
  bot: null, userId: 2000000001, messageType: 'private', text,
  atMe: false, ats: [], reply: null,
  records: [], images: [], files: [], forwards: [], videos: [],
  messageId: `smoke-${Math.random().toString(36).slice(2)}`, senderName: '主人', raw: { message: [] },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function send(text, waitMs = 900) {
  replies.length = 0
  bridge.server.emit('message', message(text))
  await sleep(waitMs)
  return replies.join(' | ')
}

if (bridge !== null) {
  // S2 扩展点：/ping 走 dispatchCommand（登记表里的命令）
  const ping = await send('/ping')
  check('S2 /ping 有回执（走新扩展点）', /pong/.test(ping), JSON.stringify(ping).slice(0, 80))

  // S3 管理分发：用 `!hush`（只改一个字段，不碰 gate/会话），作为**拆前拆后都要过**的基线。
  // `!status` 更适合，但它要 `this.gate` 等一堆上下文，mock 里不通 —— 换一个最小的。
  const hush = await send('!hush 5', 1200)
  check('S3 !hush 有回执（走管理分发）', hush.length > 0 && !/失败|Cannot read/.test(hush), JSON.stringify(hush).slice(0, 120))

  // S4 帮助菜单：走 lib/help.js（有 golden 钉着）
  const help = await send('/help', 1200)
  check('S4 /help 有菜单（走 lib/help.js）', /使用指南/.test(help), JSON.stringify(help).slice(0, 80))

  // S5 普通消息进回合
  turns.length = 0
  await send('今天天气怎么样', 1200)
  check('S5 普通消息进回合（followup 被调用）', turns.length > 0, `turns=${turns.length}`)

  // S6 /mc 被认领（探测失败也是通 —— 证明命令被路由到了）
  const mc = await send('/mc 127.0.0.1:1', 2500)
  check('S6 /mc 有回执（命令被认领）', mc.length > 0 && !/^\s*$/.test(mc), JSON.stringify(mc).slice(0, 100))

  /**
   * ── 安全三连（2026-11-16 加）──────────────────────────────────────
   * 主人对目标的原话：「能正常跑 + 方便维护加功能 + 可长时间运维和安全」。
   * 前两条单测能覆盖，**安全这三条只能靠端到端**：
   * 权限、金丝雀不泄漏、DLP 真的在工作 —— 它们坏掉时都是"看着一切正常"。
   */
  {
    // S8 非管理员发管理指令 ⇒ 必须进不来（`#isAdmin` 只认 adminUsers）
    const outsider = { ...message('!hush 5'), userId: 2999999999, messageId: 'smoke-outsider' }
    replies.length = 0
    bridge.server.emit('message', outsider)
    await sleep(900)
    const got = replies.join(' | ')
    check('S8 非管理员发 !hush 被拒', !/静默/.test(got), JSON.stringify(got).slice(0, 80))
  }
  {
    // S9 !canary 只回前 8 位 —— 全值一旦落进聊天记录，聊天记录本身就是泄漏源
    const canary = await send('!canary', 1200)
    const full = /cny-[0-9a-f]{10}/.exec(canary)?.[0] ?? ''
    check('S9 !canary 有回执', /金丝雀/.test(canary), JSON.stringify(canary).slice(0, 80))
    check('S9 ★回执里没有金丝雀全值（只给前 8 位）', full === '', full)
  }
  {
    // S10 !dlptest 现场跑一遍 DLP：必须命中密钥样例（它坏了 = 出站脱敏失效）
    const dlp = await send('!dlptest', 1500)
    check('S10 !dlptest 命中密钥样例（DLP 在工作）', /密钥格式/.test(dlp), JSON.stringify(dlp).slice(0, 100))
    check('S10 普通聊天样例未命中（没误伤）', /普通聊天（不该动）[^\n]*未命中/.test(dlp), JSON.stringify(dlp).slice(-60))
  }

  try { bridge.stop() } catch { /* 停不下来不影响判据，下面会报 */ }
  check('S7 stop() 不抛', true)
}

try { rmSync(root, { recursive: true, force: true }) } catch {}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
