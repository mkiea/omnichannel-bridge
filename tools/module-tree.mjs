/**
 * module-tree.mjs —— 把 `lib/` 的依赖关系画成一棵「能看懂的树」（2026-11-15）
 *
 * 为什么需要它：主人说「其实咱也不知道好结构应该是怎样的」。
 * 这句话是对的 —— 在量出依赖图之前，任何"应该分层""应该拆"都是凭感觉。
 * 而"好结构"在文献里也不是审美问题，是几条可测的性质：
 *
 *   · **无环**（`2406.16487`：拆完的子模块之间 acyclic dependencies 是硬要求）；
 *   · **耦合低**（SWEBOK：coupling = a measure of the interdependence among modules，
 *     `2610.32466`：判 god unit 靠 coupling，不靠复杂度）；
 *   · **枢纽不藏在深处**：一个 fan-out 40 的文件，任何改动都要经它 ⇒ 改一处动一片
 *     （`2411.01012` 的 InSep 对 co-change 多 190%，同一件事的静态版本）。
 *
 * 这个脚本只做三件事，不做判断：
 *   ① 建图（`lib/` 内部 import，靠 importSpecs 解析相对路径）；
 *   ② 报环（Tarjan SCC，size>1 就是环）；
 *   ③ 分层（SCC 收缩成 DAG 后取最长路径）——**层次不是"架构"，只是"如果按依赖深度看，
 *     谁在最底下、谁在最上面"**，用来判断"改一个底层文件要连带改多少上层"。
 *
 * 用法：
 *   node tools/module-tree.mjs            # 人看的树 + 表格
 *   node tools/module-tree.mjs --json     # 机器可读
 *   node tools/module-tree.mjs --md       # markdown（贴进 docs）
 *   node tools/module-tree.mjs --top 20   # 只看枢纽前 20
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importSpecs } from './module-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const LIB = join(REPO, 'lib')

/** 收集 `lib/` 下的所有 .js（不含子目录之外的产物）。 */
function listLib(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    let stat = null
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) listLib(full, out)
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

/** 把相对说明符解析成 lib 内的相对路径（'lib/x.js'），解析不到返回 null。 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    try {
      if (statSync(candidate).isFile()) {
        const rel = relative(REPO, candidate).split(sep).join('/')
        return rel.startsWith('lib/') ? rel : null
      }
    } catch { /* 下一个候选 */ }
  }
  return null
}

function linesOf(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).length
  } catch {
    return 0
  }
}

/** Tarjan 强连通分量（迭代版，避免深递归爆栈）。 */
function stronglyConnected(nodes, edges) {
  let index = 0
  const idx = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const comps = []

  for (const root of nodes) {
    if (idx.has(root)) continue
    const work = [{ node: root, edgeIndex: 0 }]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const node = frame.node
      if (frame.edgeIndex === 0) {
        idx.set(node, index)
        low.set(node, index)
        index += 1
        stack.push(node)
        onStack.add(node)
      }
      const outs = edges.get(node) ?? []
      if (frame.edgeIndex < outs.length) {
        const next = outs[frame.edgeIndex]
        frame.edgeIndex += 1
        if (!idx.has(next)) work.push({ node: next, edgeIndex: 0 })
        else if (onStack.has(next)) low.set(node, Math.min(low.get(node), idx.get(next)))
        continue
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent), low.get(node)))
      }
      if (low.get(node) === idx.get(node)) {
        const comp = []
        for (;;) {
          const top = stack.pop()
          onStack.delete(top)
          comp.push(top)
          if (top === node) break
        }
        comps.push(comp)
      }
    }
  }
  return comps
}

/** SCC 收缩后按最长路径分层（层 0 = 最底层，只被别人依赖）。 */
function layerize(comps, edges) {
  const compOf = new Map()
  comps.forEach((comp, i) => { for (const node of comp) compOf.set(node, i) })
  const dag = new Map(comps.map((_, i) => [i, new Set()]))
  for (const [from, outs] of edges) {
    for (const to of outs) {
      const a = compOf.get(from)
      const b = compOf.get(to)
      if (a !== undefined && b !== undefined && a !== b) dag.get(a).add(b)
    }
  }
  const memo = new Map()
  const depth = (i, seen = new Set()) => {
    if (memo.has(i)) return memo.get(i)
    if (seen.has(i)) return 0
    seen.add(i)
    let best = 0
    for (const next of dag.get(i) ?? []) best = Math.max(best, 1 + depth(next, seen))
    seen.delete(i)
    memo.set(i, best)
    return best
  }
  const out = new Map()
  for (let i = 0; i < comps.length; i += 1) out.set(i, depth(i))
  return { layers: out, compOf, dag }
}

function build() {
  const files = listLib(LIB)
  const nodes = files.map((f) => relative(REPO, f).split(sep).join('/'))
  const edges = new Map()
  const fanIn = new Map(nodes.map((n) => [n, 0]))
  for (const file of files) {
    const rel = relative(REPO, file).split(sep).join('/')
    let src = ''
    try { src = readFileSync(file, 'utf8') } catch { /* 读不到就当没依赖 */ }
    const outs = new Set()
    for (const spec of importSpecs(src)) {
      const target = resolveSpec(file, spec)
      if (target !== null && target !== rel) outs.add(target)
    }
    edges.set(rel, [...outs])
    for (const target of outs) fanIn.set(target, (fanIn.get(target) ?? 0) + 1)
  }
  const comps = stronglyConnected(nodes, edges)
  const { layers, compOf } = layerize(comps, edges)
  const rows = nodes.map((node) => {
    const comp = compOf.get(node)
    return {
      file: node,
      lines: linesOf(join(REPO, node)),
      fanIn: fanIn.get(node) ?? 0,
      fanOut: (edges.get(node) ?? []).length,
      layer: layers.get(comp) ?? 0,
      scc: (comps[comp] ?? []).length,
    }
  })
  const cycles = comps.filter((c) => c.length > 1).sort((a, b) => b.length - a.length)
  return { rows, edges, cycles, comps }
}

function renderTree(rows, top) {
  const byLayer = new Map()
  for (const row of rows) {
    const list = byLayer.get(row.layer) ?? []
    list.push(row)
    byLayer.set(row.layer, list)
  }
  const layerIds = [...byLayer.keys()].sort((a, b) => a - b)
  const out = []
  out.push('依赖层次（层 0 = 只被依赖、自己不依赖项目内模块；数字越大越"上层"）')
  for (const id of layerIds) {
    const list = byLayer.get(id).sort((a, b) => b.lines - a.lines).slice(0, top)
    const total = byLayer.get(id).length
    out.push(`\nL${id}  (${total} 个文件${total > list.length ? `，只显示前 ${list.length}` : ''})`)
    for (const row of list) {
      const mark = row.fanOut >= 10 ? ' ⚠ 枢纽' : row.scc > 1 ? ' ↻ 环' : ''
      out.push(`  ${String(row.lines).padStart(6)} L  ←${String(row.fanIn).padEnd(2)} →${String(row.fanOut).padEnd(2)}  ${row.file}${mark}`)
    }
  }
  return out.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const asMd = argv.includes('--md')
  const topFlag = argv.indexOf('--top')
  const top = topFlag >= 0 ? Math.max(3, Number(argv[topFlag + 1]) || 12) : 12

  const { rows, edges, cycles } = build()
  const totalLines = rows.reduce((s, r) => s + r.lines, 0)
  const hubs = [...rows].sort((a, b) => b.fanOut - a.fanOut)
  const roots = rows.filter((r) => r.fanIn === 0).sort((a, b) => b.lines - a.lines)
  const leaves = rows.filter((r) => r.fanOut === 0).sort((a, b) => b.lines - a.lines)

  if (asJson) {
    console.log(JSON.stringify({ totalLines, files: rows.length, cycles, hubs, roots, leaves }, null, 2))
    return
  }
  if (asMd) {
    console.log('# lib 模块依赖测量（自动生成）\n')
    console.log(`共 ${rows.length} 个文件、${totalLines.toLocaleString('en-US')} 行。\n`)
    console.log('| 文件 | 行数 | 被依赖 | 依赖别人 | 层 |')
    console.log('|---|---:|---:|---:|---:|')
    for (const row of [...rows].sort((a, b) => b.lines - a.lines)) {
      console.log(`| \`${row.file}\` | ${row.lines} | ${row.fanIn} | ${row.fanOut} | ${row.layer} |`)
    }
    console.log(`\n## 环（SCC size > 1）\n`)
    console.log(cycles.length === 0 ? '无。' : cycles.map((c) => `- ${c.join(' → ')}`).join('\n'))
    return
  }

  console.log(`\nlib 依赖测量 · ${rows.length} 个文件 / ${totalLines.toLocaleString('en-US')} 行\n`)
  console.log('─'.repeat(78))
  console.log(renderTree(rows, top))
  console.log('\n' + '─'.repeat(78))
  console.log('环（SCC size > 1）：' + (cycles.length === 0 ? '无 ✓' : ''))
  for (const cycle of cycles.slice(0, 6)) console.log(`  ↻ ${cycle.join(' → ')}`)
  console.log('─'.repeat(78))
  console.log('依赖别人的（fan-out 前 8，越大越"什么都要知道"）：')
  for (const row of hubs.slice(0, 8)) console.log(`  →${String(row.fanOut).padEnd(3)} ←${String(row.fanIn).padEnd(3)} ${row.file}  (${row.lines} L)`)
  console.log('没人依赖的（fan-in = 0，通常是入口或死文件）：')
  for (const row of roots.slice(0, 6)) console.log(`  ${row.file}  (${row.lines} L, →${row.fanOut})`)
  console.log('')
}

main()
