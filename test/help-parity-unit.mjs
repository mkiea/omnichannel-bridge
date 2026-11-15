/**
 * `/help` 迁移的长期守门测试（2026-11-15）。
 *
 * 迁 `#handleHelp` 时最大的风险不是"跑不起来"，而是**悄悄少了一行字**：
 * 141 行里有 42 条 `if (cond) lines.push('…')`，抄漏一条不会报错，
 * 只会让某个功能的说明从此消失 —— 而没有人会去数帮助菜单的行数。
 *
 * 基准是 `test/fixtures/help-golden.json`：**迁移前那一刻的文案与条件快照**
 * （从 `lib/bridge.js @ 8d955ec` 的 `#handleHelp` 抽出来的）。
 *
 * 这么设计是为了让基准"能长期用"：
 *   · 如果测试去读 bridge.js 里那份旧实现，那旧实现一删测试就废了；
 *   · 改用快照之后，改 help.js 的文案/条件必须**显式**更新 golden ——
 *     "帮助菜单变了"变成一个要人点头的动作，而不是顺手就漂了。
 *
 * 口径（先声明）：
 *   · 文案里的模板变量统一替换成 `@`（`config.x` / `this.config.x` 语义相同）；
 *     **变量抄错抓不到**，需要人工核；
 *   · 条件对比用排序后的多重集（不对比顺序，嵌套结构不保证一致）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 用产线的 importSpecs（它会先掩掉注释）而不是裸正则：
// 第一版用正则直接扫，结果被 help.js 头注释里那句「一旦 import './bridge.js' 就 FAIL」
// 判成了真依赖 —— 注释里的例子不是 import。
import { importSpecs } from '../tools/module-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

function extract(src) {
  const pushes = []
  const conds = []
  const pushRe = /\.push\(\s*(['"`])([\s\S]*?)\1\s*\)/g
  let m = pushRe.exec(src)
  while (m !== null) {
    pushes.push(m[2].replace(/\$\{[^}]*\}/g, '@'))
    m = pushRe.exec(src)
  }
  const condRe = /^\s*if\s*\((.+)\)\s*\{?\s*$/gm
  let c = condRe.exec(src)
  while (c !== null) { conds.push(c[1].trim()); c = condRe.exec(src) }
  return { pushes, conds }
}

function normCond(cond) {
  return cond
    .replace(/this\./g, '')
    .replace(/message\.messageType\s*===\s*'group'/g, 'IS_GROUP')
    .replace(/chatType\s*===\s*'group'/g, 'IS_GROUP')
    .replace(/\bisGroup\b/g, 'IS_GROUP')
    .replace(/message\.messageType\s*===\s*'private'/g, 'IS_PRIVATE')
    .replace(/chatType\s*===\s*'private'/g, 'IS_PRIVATE')
    .replace(/#?isAdmin\(message\)/g, 'ADMIN')
    .replace(/\bisAdmin\b/g, 'ADMIN')
    .replace(/#?engageOn\('([^']+)'\)/g, 'ENGAGE($1)')
    .replace(/\bconfig\./g, 'C.')
    .replace(/\bfun\./g, 'F.')
    .replace(/\(hasBroadcast \|\| hasWebhook\)/g, '(BROADCAST_OR_WEBHOOK)')
    .replace(/\(broadcast \|\| webhook\)/g, '(BROADCAST_OR_WEBHOOK)')
    .replace(/\s+/g, '')
}

const golden = JSON.parse(readFileSync(join(HERE, 'fixtures', 'help-golden.json'), 'utf8'))
const helpSrc = readFileSync(join(REPO, 'lib', 'help.js'), 'utf8')
const bridgeSrc = readFileSync(join(REPO, 'lib', 'bridge.js'), 'utf8')

const newBody = helpSrc.slice(helpSrc.indexOf('export function helpLines({'), helpSrc.indexOf('return lines'))
const neu = extract(newBody)

check('基准文件可读', Array.isArray(golden.pushes) && golden.pushes.length > 0, `${golden.pushes.length} 条文案`)
check('文案条数一致', golden.pushes.length === neu.pushes.length,
  `基准 ${golden.pushes.length} / 现 ${neu.pushes.length}`)

let firstDiff = -1
for (let i = 0; i < Math.min(golden.pushes.length, neu.pushes.length); i += 1) {
  if (golden.pushes[i] !== neu.pushes[i]) { firstDiff = i; break }
}
check('文案逐条一致（顺序 + 内容）', firstDiff === -1,
  firstDiff === -1 ? '' : `第 ${firstDiff + 1} 条不同：\n  基准: ${golden.pushes[firstDiff]}\n  现在: ${neu.pushes[firstDiff]}`)

const newConds = neu.conds.map(normCond).sort()
const condSame = golden.conds.length === newConds.length && golden.conds.every((c, i) => c === newConds[i])
check('if 条件多重集一致（防「默认值被改」）', condSame,
  condSame ? `共 ${golden.conds.length} 个条件` : `基准 ${golden.conds.length} / 现 ${newConds.length}\n  只在基准: ${golden.conds.filter((c) => !newConds.includes(c)).slice(0, 3).join(' | ')}\n  只在现在: ${newConds.filter((c) => !golden.conds.includes(c)).slice(0, 3).join(' | ')}`)

// ── 迁移本身的三条结构断言 ──────────────────────────────────────────────────
const start = bridgeSrc.indexOf('async #handleHelp(message) {')
const end = bridgeSrc.indexOf('  /** 每日签到', start)
const bridgeHelp = start >= 0 && end > start ? bridgeSrc.slice(start, end) : ''

check('bridge 的 #handleHelp 已经不含文案（没有两份逻辑并存）',
  start >= 0 && !bridgeHelp.includes('.push('),
  start >= 0 ? `方法体 ${bridgeHelp.split('\n').length} 行` : '找不到 #handleHelp')
check('bridge 通过 helpLines 组装', bridgeHelp.includes('helpLines({'))
const specs = importSpecs(helpSrc)
check('help.js 没有反向依赖 bridge（枝不 import 干）',
  !specs.some((spec) => /bridge/.test(spec)),
  specs.length > 0 ? `imports: ${specs.join(', ')}` : '（无 import）')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
