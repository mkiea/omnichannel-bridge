/**
 * host-guard.mjs —— 宿主侧「会不会自己烧钱」的只读体检。
 *
 * 由来（2026-11-15）：视频 BV1sZWo6PEFG 说「两个插件组合、白名单缺 compress、
 * 一直压缩失败、一小时烧光 token」。我们链路上没有那个白名单（桥建会话只传
 * provider/model），dsh 的压缩是自动的且有上限（compactionRetries=1），所以那个
 * 具体坑不成立 —— 但**同一个形状**（缺东西 ⇒ 每轮都试 ⇒ 每一轮都花钱）在本机
 * 撞过三次：qzone 1404、describe_image 缺失、B 站/yt-dlp 缺失。
 *
 * 所以这个脚本不查「代码里有没有 bug」，只查**运行时有没有出现那个形状**：
 *   · 同一个 dataRoot 是不是被两个 profile 同时指着（两套主动通道各开各的火）
 *   · 状态文件里记的 pid 还是不是同一个进程（双宿主写同一份账）
 *   · 最近一次异常距今多久、连续失败几次（有没有在循环里）
 *   · 主动通道是不是正在退避（它在退避 = 之前失败过，别再往上加火）
 *   · 今天已经花掉多少（钱是唯一不可伪造的判据）
 *   · 注入队列有没有积压（dry-run 只拦出站，**不拦模型回合**）
 *
 * 只读：不写任何状态文件、不启动/停止任何进程、不发网络请求。
 *
 * 用法：node tools/host-guard.mjs [--json] [--data-root <qq_chat 路径>]
 * 退出码：0 = 全 PASS/SKIP；1 = 有 WARN；2 = 有 FAIL
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

const args = process.argv.slice(2)
const wantJson = args.includes('--json')
const rootFlag = args.indexOf('--data-root')
const dataRoot = rootFlag >= 0 && args[rootFlag + 1]
  ? resolve(args[rootFlag + 1])
  : resolve(REPO, '..', 'qq_chat')

const results = []
/** @param {'PASS'|'WARN'|'FAIL'|'SKIP'} status */
function item(id, title, status, detail, fix = '') {
  results.push({ id, title, status, detail, fix })
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ageText(ms) {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s} 秒前`
  if (s < 5400) return `${Math.round(s / 60)} 分钟前`
  if (s < 172800) return `${(s / 3600).toFixed(1)} 小时前`
  return `${(s / 86400).toFixed(1)} 天前`
}

/** pid 是否还活着（不发信号，只做存在性探测）。EPERM 也算活着。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// ── ① 有几个 profile 指着同一个 dataRoot ────────────────────────────────────────
// 两个 profile 共用一个 cwd = 两套主动通道、两套会话映射、两套注入通道，
// 而它们之间唯一的协调是 `qq-proactive-state.json` 里的 `_meta.pid`（还只在主动通道生效）。
function checkProfilesSharingRoot() {
  const dir = join(DSH_HOME, 'profiles')
  if (!existsSync(dir)) {
    item('profiles', 'profile 隔离', 'SKIP', `${dir} 不存在（本机不是 dsh 安装？）`)
    return
  }
  const hits = []
  let scanned = 0
  for (const name of readdirSync(dir)) {
    const patch = join(dir, name, 'cordis.patch.yml')
    if (!existsSync(patch)) continue
    scanned += 1
    let text = ''
    try {
      text = readFileSync(patch, 'utf8')
    } catch {
      continue
    }
    // 只看**没被注释掉**的行：注释里的 cwd 是"历史/回滚说明"，不该算在册。
    const lines = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line))
    const cwds = []
    for (const line of lines) {
      const m = line.match(/^\s*cwd:\s*['"]?(.+?)['"]?\s*$/)
      if (m) cwds.push(m[1].replace(/\\\\/g, '\\').replace(/\\/g, '/'))
    }
    if (cwds.some((c) => c.toLowerCase().endsWith('/qq_chat'))) hits.push(name)
  }
  if (scanned === 0) {
    item('profiles', 'profile 隔离', 'SKIP', '没扫到任何 cordis.patch.yml')
    return
  }
  // 怎么数：备份目录（名字含 backup/bak/old）与被 `dsh --profile` 指到的"活"profile
  // 后果不同 —— 前者要有人手动指过去才会跑，后者开机就可能起。分开报，别混成一个数。
  const archived = hits.filter((n) => /backup|bak|old|copy|backup-/i.test(n))
  const active = hits.filter((n) => !archived.includes(n))
  if (active.length > 1) {
    item('profiles', 'profile 隔离', 'FAIL',
      `${active.length} 个活 profile 同时指向 qq_chat：${active.join('、')}`,
      '同一份数据只能有一个宿主写；另一个要么删掉配置，要么把 cwd 改到别处')
    return
  }
  if (archived.length > 0) {
    item('profiles', 'profile 隔离', 'WARN',
      `活 profile ${active.length} 个（${active[0] ?? '无'}）；另有 ${archived.length} 个备份目录也留着指向 qq_chat 的配置：${archived.join('、')}`,
      '备份里的配置带完整凭证与 cwd，被 --profile 指到就是第三套；建议删掉备份目录或把其中 cwd 行注释掉')
    return
  }
  item('profiles', 'profile 隔离', 'PASS', `${scanned} 个 profile，指向 qq_chat 的只有 ${active[0] ?? '（无）'}`)
}

// ── ② 状态文件里的 pid 是不是同一个活进程 ──────────────────────────────────────
function checkSoleWriter() {
  const runtime = readJson(join(dataRoot, 'qq-runtime.json'))
  const proactive = readJson(join(dataRoot, 'qq-proactive-state.json'))
  const runtimePid = Number(runtime?.pid) || 0
  const metaPid = Number(proactive?._meta?.pid) || 0

  if (runtimePid === 0 && metaPid === 0) {
    item('sole-writer', '单宿主', 'SKIP', '两份状态文件都没有 pid（桥没跑过，或版本较旧）')
    return
  }
  const runtimeAlive = pidAlive(runtimePid)
  const metaAlive = pidAlive(metaPid)
  if (!runtimeAlive && !metaAlive) {
    item('sole-writer', '单宿主', 'WARN',
      `runtime pid=${runtimePid} / 主动账 pid=${metaPid} 都已不在（宿主停了，或状态文件是陈旧的）`)
    return
  }
  if (runtimePid !== 0 && metaPid !== 0 && runtimePid !== metaPid && runtimeAlive && metaAlive) {
    item('sole-writer', '单宿主', 'FAIL',
      `两个**活着的**宿主在写同一份账：runtime pid=${runtimePid}，主动账 _meta.pid=${metaPid}`,
      '主动通道会各自排计划、同一天可能找同一个人两次；先确认哪个是你要留的，再把另一个停掉')
    return
  }
  const live = runtimeAlive ? runtimePid : metaPid
  const uptime = Number(runtime?.uptimeSeconds) || 0
  const snapshotAt = Number(runtime?.updatedAt) || 0
  const stale = snapshotAt > 0 ? Date.now() - snapshotAt : 0
  item('sole-writer', '单宿主', 'PASS',
    `pid=${live} 存活${uptime ? `，快照时已跑 ${(uptime / 3600).toFixed(1)} 小时` : ''}`
    + (stale > 120_000 ? `（快照 ${ageText(stale)}写的，不是实时值）` : '')
    + (runtimePid !== metaPid && metaPid !== 0 ? `（陈旧 pid ${runtimePid === live ? metaPid : runtimePid} 已忽略）` : ''))
}

// ── ③ 最近异常与连续失败 ──────────────────────────────────────────────────────
function checkHostHealth() {
  const health = readJson(join(dataRoot, 'qq-host-health.json'))
  if (health === null) {
    item('health', '宿主/API 健康', 'SKIP', '没有 qq-host-health.json（桥还没跑完过一回合）')
    return
  }
  const now = Date.now()
  const lastIssue = Number(health.lastIssueAt) || 0
  const lastOk = Number(health.lastOkAt) || 0
  const streak = Number(health.consecutiveFailures) || 0
  const kind = String(health.lastIssueKind ?? '')
  const reason = String(health.lastIssueReason ?? '').slice(0, 90)
  if (lastIssue === 0) {
    item('health', '宿主/API 健康', 'PASS', '无异常记录')
    return
  }
  const age = now - lastIssue
  const tail = `${kind}：${reason}`
  if (age < 15 * 60_000) {
    item('health', '宿主/API 健康', streak >= 3 ? 'FAIL' : 'WARN',
      `${ageText(age)}报错，连续 ${streak} 次 · ${tail}`,
      streak >= 3 ? '连续失败 = 已经在循环里，先看上游 API 状态，别让它继续开火' : '')
    return
  }
  item('health', '宿主/API 健康', 'PASS',
    `上次异常 ${ageText(age)}（${tail}）${lastOk ? `，最后一次正常回合在 ${ageText(now - lastOk)}` : ''}`)
}

// ── ④ 主动通道是否在退避 ──────────────────────────────────────────────────────
// 退避函数与桥同源：1 次 2min、2 次 5min、3 次 15min、≥4 次 1h。
function proactiveBackoffMs(failures) {
  const n = Number(failures) || 0
  if (n <= 0) return 0
  if (n === 1) return 120_000
  if (n === 2) return 300_000
  if (n === 3) return 900_000
  return 3_600_000
}

function checkProactiveBackoff() {
  const state = readJson(join(dataRoot, 'qq-proactive-state.json'))
  if (state === null) {
    item('proactive', '主动通道退避', 'SKIP', '没有 qq-proactive-state.json')
    return
  }
  const now = Date.now()
  const waiting = []
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith('_') || key.endsWith('#dry')) continue
    const failures = Number(value?.failedAttempts) || 0
    if (failures <= 0) continue
    const window = proactiveBackoffMs(failures)
    const last = Number(value?.lastFailedAt) || 0
    const remaining = last === 0 ? 0 : Math.max(0, window - (now - last))
    waiting.push({ key, failures, remaining, outcome: String(value?.lastOutcome ?? '') })
  }
  if (waiting.length === 0) {
    item('proactive', '主动通道退避', 'PASS', '没有在退避的会话（说明近期没连续失败）')
    return
  }
  const worst = waiting.sort((a, b) => b.failures - a.failures)[0]
  const detail = waiting
    .map((w) => `${w.key} 连续 ${w.failures} 次${w.remaining > 0 ? `（还剩 ${Math.ceil(w.remaining / 1000)}s）` : '（窗口已过）'}${w.outcome ? ` · ${w.outcome}` : ''}`)
    .join('；')
  item('proactive', '主动通道退避', worst.failures >= 3 ? 'FAIL' : 'WARN',
    detail,
    worst.failures >= 3 ? '连续失败 ≥3 次说明它在反复开火，先查失败原因再让它继续' : '')
}

// ── ⑤ 今天花了多少 ────────────────────────────────────────────────────────────
// 钱是唯一不可伪造的判据：请求数可以重试、token 可以缓存，账单是实的。
function checkTodaySpend() {
  const file = join(DSH_HOME, 'data', 'dsh-token-monitor', 'usage.jsonl')
  if (!existsSync(file)) {
    item('spend', '今日花费', 'SKIP', `${file} 不存在（没装 token 监控）`)
    return
  }
  const today = localDayKey(new Date())
  let qq = { n: 0, cost: 0, out: 0 }
  let other = { n: 0, cost: 0, out: 0 }
  let lines = 0
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (line === '') continue
      lines += 1
      let row = null
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const ts = Number(row?.timestamp) || 0
      if (ts === 0) continue
      if (localDayKey(new Date(ts)) !== today) continue
      const bucket = String(row.sessionId ?? '').startsWith('qq-') ? qq : other
      bucket.n += 1
      bucket.cost += Number(row.cost) || 0
      bucket.out += Number(row.outputTokens) || 0
    }
  } catch (error) {
    item('spend', '今日花费', 'SKIP', `读不出来：${error.message}`)
    return
  }
  if (lines === 0) {
    item('spend', '今日花费', 'SKIP', '账本是空的')
    return
  }
  const total = qq.cost + other.cost
  const detail = `QQ ${qq.n} 次 ¥${qq.cost.toFixed(3)}（出 ${qq.out} tok）· 其它 ${other.n} 次 ¥${other.cost.toFixed(3)} · 合计 ¥${total.toFixed(2)}`
  // 阈值是"看得见异常"用的，不是预算：19 天实测日均 ¥0.25、峰值 ¥0.69。
  if (total >= 20) {
    item('spend', '今日花费', 'FAIL', detail, '超过历史峰值 30 倍，先停下来看账本里是谁在烧')
  } else if (total >= 5) {
    item('spend', '今日花费', 'WARN', detail, '超过历史峰值 7 倍，翻一眼 usage.jsonl 的 sessionId')
  } else {
    item('spend', '今日花费', 'PASS', detail)
  }
}

// ── ⑥ 注入队列积压 ────────────────────────────────────────────────────────────
// dry-run 只把 OneBot 切到"不回 QQ"，**模型回合照跑**（#handleInjection 里 injectDryRun
// 只用于 setDryRun 与 gate，followup 不受影响）。所以"干跑很安全"是错觉的一半。
function checkInjectQueue() {
  const runtime = readJson(join(dataRoot, 'qq-runtime.json'))
  const file = join(dataRoot, 'qq-inject.jsonl')
  if (!existsSync(file)) {
    item('inject', '注入队列', 'SKIP', '没有 qq-inject.jsonl')
    return
  }
  let lines = 0
  let bytes = 0
  try {
    const stat = statSync(file)
    bytes = stat.size
    const text = readFileSync(file, 'utf8')
    lines = text.split('\n').filter((l) => l.trim() !== '').length
  } catch (error) {
    item('inject', '注入队列', 'SKIP', `读不出来：${error.message}`)
    return
  }
  const dry = runtime?.injection?.dryRun !== false
  const consumed = Number(runtime?.injection?.consumed) || 0
  if (lines === 0) {
    item('inject', '注入队列', 'PASS', `空（consumed=${consumed}，dryRun=${dry}）`)
    return
  }
  // 启动时会跳过历史行（reset(true)），所以"文件里有残留"不等于"会跑"。
  item('inject', '注入队列', 'PASS',
    `${lines} 行 / ${mib(bytes)}，已消费 ${consumed}，dryRun=${dry}`
    + (consumed === 0 ? '（启动时跳过历史行，残留不会被重放）' : '')
    + (dry ? '；注意 dry-run 只拦出站，模型回合照跑' : '；**真发模式**，每条都会真发'))
}

checkProfilesSharingRoot()
checkSoleWriter()
checkHostHealth()
checkProactiveBackoff()
checkTodaySpend()
checkInjectQueue()

const order = { FAIL: 0, WARN: 1, PASS: 2, SKIP: 3 }
results.sort((a, b) => order[a.status] - order[b.status])
const worst = results.some((r) => r.status === 'FAIL') ? 'FAIL'
  : results.some((r) => r.status === 'WARN') ? 'WARN' : 'PASS'

if (wantJson) {
  console.log(JSON.stringify({ dataRoot, worst, checks: results }, null, 2))
} else {
  console.log(`\n宿主体检 · dataRoot=${dataRoot}`)
  console.log('─'.repeat(78))
  for (const r of results) {
    console.log(`${r.status.padEnd(4)} ${r.title.padEnd(14, '　')} ${r.detail}`)
    if (r.fix !== '') console.log(`     ↳ ${r.fix}`)
  }
  console.log('─'.repeat(78))
  const fails = results.filter((r) => r.status === 'FAIL').length
  const warns = results.filter((r) => r.status === 'WARN').length
  console.log(`结论：${worst}（FAIL ${fails} / WARN ${warns} / 共 ${results.length} 项）\n`)
}

process.exit(worst === 'FAIL' ? 2 : worst === 'WARN' ? 1 : 0)
