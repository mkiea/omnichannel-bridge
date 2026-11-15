/**
 * 模块规模闸门必须跟着全量测试一起跑（2026-11-15）。
 *
 * 为什么把闸门本身做成一条测试：闸门最常见的死法不是判错，而是**没人跑**。
 * 单独一个 `npm run gate` 靠自觉，三个月后就会变成"那个脚本啊，好像有"。
 * 挂进 `test:all` 之后，任何一次全量测试都会顺手把技术债量一遍。
 *
 * 这里验两件事（都要验，只验一面等于恒真）：
 *   ① `--selftest`：闸门自己的判据还分得清（合规 / 恰好超限 / 依赖方向 / 掩码）
 *   ② 正式检查：当前仓库在 baseline 之内（ratchet 没有违约）
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const GATE = join(REPO, 'tools', 'module-gate.mjs')

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

function run(args) {
  try {
    const out = execFileSync(process.execPath, [GATE, ...args], { cwd: REPO, encoding: 'utf8' })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const selftest = run(['--selftest'])
check('闸门自检全绿（10 条判据）', selftest.code === 0, selftest.code === 0 ? '' : selftest.out.slice(0, 400))
check('自检输出里没有 FAIL 行', !/^FAIL /m.test(selftest.out), '')

const gate = run([])
const failLines = gate.out.split('\n').filter((line) => line.startsWith('FAIL '))
check('当前仓库通过规模闸门（无 ratchet 违约）', gate.code === 0,
  gate.code === 0 ? '' : failLines.slice(0, 6).join(' | '))
check('依赖方向无违规（枝没有 import 干）', !gate.out.includes('枝不许依赖干'),
  gate.out.includes('枝不许依赖干') ? 'lib/ 下有模块反向引用了 bridge.js' : '')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
