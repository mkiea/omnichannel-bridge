/**
 * 命令注册表的单测（2026-11-16，扩展点的地基）。
 *
 * 钉的是**语义**，不是实现：
 *   · 形状校验要在**建表时**就失败（而不是等某条命令在运行期炸）；
 *   · 顺序 = 数组顺序，命中即停（命令之间有真实优先级，不能被"谁先注册"打乱成巧合）；
 *   · `enabled` 为 false 时**不执行**（不是执行了再返回 false —— 那会白跑副作用）；
 *   · 都不命中返回 null（调用方据此继续往下走）；
 *   · **异常不吞**：一个命令抛错，要让调用方的 try 接住并记 trace，而不是被这里咽掉。
 */
import { createCommandRegistry, dispatchCommand } from '../lib/commands/registry.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const port = { config: {} }

// ── 形状校验 ────────────────────────────────────────────────────────────────
{
  let threw = false
  try { createCommandRegistry(null) } catch { threw = true }
  check('非数组建表抛错', threw)
}
{
  let threw = false
  try { createCommandRegistry([{ name: 'x' }]) } catch { threw = true }
  check('缺 run 抛错', threw)
}
{
  let threw = false
  try { createCommandRegistry([{ name: '', run: async () => false }]) } catch { threw = true }
  check('空 name 抛错', threw)
}
{
  let threw = false
  try {
    createCommandRegistry([
      { name: 'dup', run: async () => false },
      { name: 'dup', run: async () => false },
    ])
  } catch { threw = true }
  check('重名抛错（启动即失败，而不是运行期覆盖）', threw)
}
{
  let threw = false
  try { createCommandRegistry([{ name: 'e', run: async () => false, enabled: true }]) } catch { threw = true }
  check('enabled 不是函数抛错', threw)
}

// ── 分发语义 ────────────────────────────────────────────────────────────────
{
  const order = []
  const reg = createCommandRegistry([
    { name: 'a', traceLabel: 'A', run: async () => { order.push('a'); return false } },
    { name: 'b', traceLabel: 'B', run: async () => { order.push('b'); return true } },
    { name: 'c', traceLabel: 'C', run: async () => { order.push('c'); return true } },
  ])
  const hit = await dispatchCommand(reg, port, {}, '')
  check('按数组顺序试，命中即停', JSON.stringify(order) === '["a","b"]', JSON.stringify(order))
  check('返回命中信息（含 traceLabel）', hit !== null && hit.name === 'b' && hit.traceLabel === 'B', JSON.stringify(hit))
}
{
  const reg = createCommandRegistry([
    { name: 'off', run: async () => { throw new Error('不该被执行') }, enabled: () => false },
    { name: 'on', run: async () => true },
  ])
  const hit = await dispatchCommand(reg, port, {}, '')
  check('enabled=false 的命令不被执行（不是执行后丢弃）', hit !== null && hit.name === 'on', JSON.stringify(hit))
}
{
  const reg = createCommandRegistry([
    { name: 'a', run: async () => false },
    { name: 'b', run: async () => false },
  ])
  const hit = await dispatchCommand(reg, port, {}, '')
  check('全不命中返回 null', hit === null)
}
{
  const reg = createCommandRegistry([{ name: 'boom', run: async () => { throw new Error('inner') } }])
  let thrown = ''
  try { await dispatchCommand(reg, port, {}, '') } catch (error) { thrown = error.message }
  check('异常向上抛（不被吞）', thrown === 'inner', thrown)
}
{
  const reg = createCommandRegistry([{ name: 'x', run: async () => 'truthy-but-not-true' }])
  const hit = await dispatchCommand(reg, port, {}, '')
  check('只有严格 true 算命中（避免返回值歧义）', hit === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
