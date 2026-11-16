/**
 * module-relative.mjs —— 按**本项目自己**的分布判断"哪个文件算超常"（2026-11-16）
 *
 * 为什么单独一个工具：`module-gate.mjs` 的 `800 / 160KB / 120 / 80` 是**绝对**阈值，
 * 它的作用是"防恶化"（ratchet 只许降不许升），**不适合回答"这个文件是不是真的超常"**。
 * 两条独立研究给的是同一个答案：
 *   · `2610.32466`（arXiv）：`a constant derived from a corpus is a statement about that corpus`，
 *     并给了 scale-free 规则 —— **median + MAD，modified z ≥ 3.5**；
 *   · 《软件学报》2022（`jos-2022-godclass`）：`将项目中上帝类相关度量指标的平均值作为基准,
 *     设计实验确定比例因子, 并以平均值和比例因子的乘积作为阈值`。
 *
 * 所以这里**不引入新的意见**，只是把已经认过的那条落地：判据相对本项目。
 *
 * ⚠️ 用**中位数**而不是均值：`bridge.js` 有一万三千行，均值会被它自己拉高 ——
 * 那正是"用最大值抬高门槛"的经典错误。
 *
 * 用法：
 *   node tools/module-relative.mjs            # 表格
 *   node tools/module-relative.mjs --json     # 机器可读
 *   node tools/module-relative.mjs --z 3.5    # 自定义阈值（默认 3.5，来自 2610.32466）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureSource } from './module-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCAN_DIRS = ['lib', 'tools', 'test', 'control', 'launcher']

/** 递归收集 `.js` / `.mjs`（跳过 node_modules 与测试产生的临时目录）。 */
function walk(dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    let st = null
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (/\.(mjs|js)$/.test(name)) out.push(full)
  }
  return out
}

function median(xs) {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function mad(xs, m) {
  if (xs.length === 0) return 0
  return median(xs.map((x) => Math.abs(x - m)))
}

/** modified z（Iglewicz & Hoaglin）；MAD=0 时退化成"只在等于中位数时算 0"。 */
function modZ(x, m, md) {
  if (md === 0) return x === m ? 0 : Number.POSITIVE_INFINITY
  return 0.6745 * (x - m) / md
}

function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const zFlag = argv.indexOf('--z')
  const zThreshold = zFlag >= 0 ? Number(argv[zFlag + 1]) || 3.5 : 3.5

  const files = SCAN_DIRS.flatMap((d) => walk(join(REPO, d)))
  const rows = files.map((full) => {
    const rel = relative(REPO, full).split(sep).join('/')
    let src = ''
    try { src = readFileSync(full, 'utf8') } catch { /* 读不到就跳过 */ }
    const m = measureSource(src, rel)
    return { file: rel, lines: m.lines, bytes: m.bytes, maxFunctionLines: m.maxFunctionLines, maxFunctionName: m.maxFunctionName, maxClassMethods: m.maxClassMethods }
  }).filter((r) => r.lines > 0)

  const metrics = [
    { key: 'lines', label: '行数' },
    { key: 'bytes', label: '字节' },
    { key: 'maxFunctionLines', label: '最长函数' },
    { key: 'maxClassMethods', label: '单类方法数' },
  ]
  const stats = metrics.map(({ key, label }) => {
    const xs = rows.map((r) => Number(r[key]) || 0)
    const m = median(xs)
    const md = mad(xs, m)
    const outliers = rows
      .map((r) => ({ file: r.file, value: Number(r[key]) || 0, z: modZ(Number(r[key]) || 0, m, md) }))
      .filter((o) => o.z >= zThreshold)
      .sort((a, b) => b.z - a.z)
    return { key, label, median: m, mad: md, degraded: md === 0, outliers, n: xs.length }
  })

  if (asJson) {
    console.log(JSON.stringify({ fileCount: rows.length, zThreshold, stats }, null, 2))
    return
  }

  console.log(`\nlib 规模离群分析 · ${rows.length} 个文件 · scale-free（median + MAD，|z| ≥ ${zThreshold}）`)
  console.log('─'.repeat(78))
  console.log('指标'.padEnd(12) + '中位数'.padStart(10) + 'MAD'.padStart(10) + '离群'.padStart(8) + '  说明')
  for (const s of stats) {
    const note = s.degraded ? 'MAD=0（这个指标在本项目里没有分布，无法判离群）' : ''
    console.log(s.label.padEnd(12) + String(s.median).padStart(10) + String(s.mad).padStart(10) + String(s.outliers.length).padStart(8) + '  ' + note)
  }
  console.log('─'.repeat(78))
  for (const s of stats) {
    if (s.degraded || s.outliers.length === 0) continue
    console.log(`\n${s.label}离群（前 ${Math.min(6, s.outliers.length)} 个）：`)
    for (const o of s.outliers.slice(0, 6)) {
      const times = s.median === 0 ? '—' : `${(o.value / s.median).toFixed(1)}× 中位数`
      console.log(`  z=${String(o.z === Infinity ? '∞' : o.z.toFixed(1)).padStart(5)}  ${String(o.value).padStart(7)}  ${times.padEnd(16)} ${o.file}`)
    }
  }
  console.log('')
}

main()
