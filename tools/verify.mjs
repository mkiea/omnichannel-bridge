/**
 * verify.mjs —— 一条命令跑完所有检查（2026-11-16）
 *
 * 为什么要有它：`OPERATIONS.md` §4 里写了四条命令，但"要跑四次"这件事本身就让人不想跑。
 * 一个没人跑的自检脚本等于没有。所以给它一个入口，输出**一句话结论**。
 *
 * 用法：
 *   node tools/verify.mjs           # 四关全跑（约 8 分钟，含全量）
 *   node tools/verify.mjs --quick   # 只跑前三关（约 30 秒）——日常改完代码用这个
 *   node tools/verify.mjs --json    # 机器可读
 *
 * 判据：**任一步 exit≠0 即整体失败**。不做"跳过失败继续跑"——那种报告没人信。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const quick = argv.includes('--quick')
const asJson = argv.includes('--json')

/** 四关，按"越快越先跑"排：先失败先停，不浪费 7 分钟。 */
const STEPS = [
  { id: 'gate', label: '结构闸门（ratchet）', script: 'tools/module-gate.mjs', budget: '2s' },
  { id: 'smoke', label: '冒烟（构造/分发/权限/DLP/自检）', script: 'test/smoke-run.mjs', budget: '13s' },
  { id: 'admin', label: '管理指令 E2E（14 个分支）', script: 'test/admin-commands-e2e.mjs', budget: '16s' },
  { id: 'all', label: '全量套件（143 个）', script: 'tools/test-all.mjs', budget: '8min', skipInQuick: true },
]

function runOne(step) {
  const started = Date.now()
  const res = spawnSync(process.execPath, [join(REPO, step.script)], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60_000,
  })
  const ms = Date.now() - started
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  // 只留最后几行非空内容用于失败时的定位（全量会刷几百行，不能全打）
  const tail = out.split('\n').filter((l) => l.trim() !== '').slice(-6)
  return { id: step.id, label: step.label, ok: res.status === 0, ms, tail }
}

const planned = STEPS.filter((s) => !(quick && s.skipInQuick))
const results = []
let stopped = null

for (const step of planned) {
  if (!asJson) process.stdout.write(`[${results.length + 1}/${planned.length}] ${step.label} … `)
  const r = runOne(step)
  results.push(r)
  if (!asJson) {
    const secs = (r.ms / 1000).toFixed(r.ms < 10_000 ? 1 : 0)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}（${secs}s）`)
  }
  if (!r.ok) { stopped = r; break }
}

const allOk = results.length === planned.length && results.every((r) => r.ok)

if (asJson) {
  console.log(JSON.stringify({ quick, allOk, results }, null, 2))
} else {
  if (stopped !== null) {
    console.log(`\n❌ 停在「${stopped.label}」—— 最后几行：`)
    for (const line of stopped.tail) console.log(`   ${line}`)
    console.log('\n修完再跑一次；**不要**带着红的自检去重启，那样你分不清是谁的问题。')
  } else {
    const names = results.map((r) => r.label.replace(/（.*?）/, '')).join(' / ')
    console.log(`\n✅ ${planned.length} 关全过（${names}）`)
    console.log('   → 可以重启了。重启后先发 `/health`，再随便聊一句。')
    if (quick) console.log('   （--quick 模式跳过了全量；提交前或不放心时跑不带参数的版本）')
  }
}

process.exit(allOk ? 0 : 1)
