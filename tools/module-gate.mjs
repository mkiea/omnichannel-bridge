/**
 * module-gate.mjs —— 模块规模的硬闸门（2026-11-15）
 *
 * 为什么要有它：`lib/bridge.js` 长到 14,360 行、348 个方法，是典型的 **God File**
 * （Fowler《Refactoring》的 Large Class 坏味道；Parnas 1972 讲的正是"按信息隐藏切模块"，
 * 而不是按执行顺序堆在一个类里）。光靠"以后注意"拦不住 —— 每次加功能都是往那个文件里
 * 插五十行，插了两年就是现在这个样子。所以这条规则必须是**可执行的闸**，不是一句约定。
 *
 * 闸门的三条设计原则（缺一条就会退化成装饰）：
 *   ① **只许降不许升**（ratchet）：现状登记进 baseline，任何指标变大立刻 FAIL。
 *      没有 ratchet 的话，"先超一点、下次再还"就是永久的借口。
 *   ② **新文件没有豁免**：baseline 只保护"历史债"，新写的文件一律按限值判。
 *   ③ **自己也要能被检验**：`--selftest` 用三种已知材料（合规 / 恰好超限 / 严重超标）
 *      验证闸门真的能分辨 —— 恒返回绿的闸门比没有闸门更糟（它给了虚假的安全感）。
 *
 * 度量口径（**代理指标，不是 AST 精确值**，这里必须先说清楚）：
 *   · lines     —— 物理行数（含注释与空行）。选择它是因为"人读文件"的成本与物理行相关；
 *   · bytes     —— UTF-8 字节数。中文注释占比高的文件，行数会低估体量，所以两条一起卡；
 *   · maxFunctionLines —— 具名函数/方法的行数：定义行到配平的 `}` 所在行。
 *                  跳过字符串/注释/正则里的花括号（用等长掩码，不是正则替换 —— 后者会挪行号）；
 *   · maxClassMethods —— 单个 class 体内的方法个数（按缩进 2 空格的方法定义计）。
 *
 * 用法：
 *   node tools/module-gate.mjs                # 检查（CI / 提交前）
 *   node tools/module-gate.mjs --json         # 机器可读
 *   node tools/module-gate.mjs --ratchet      # 把变小的值收紧进 baseline（只能收紧）
 *   node tools/module-gate.mjs --selftest     # 用三种已知材料验证闸门本身
 *
 * 退出码：0 = 全过；1 = 有 ratchet 违约或新文件超标；2 = 闸门自身跑不起来。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const BASELINE = join(HERE, 'module-baseline.json')

/**
 * 限值从哪来 —— 先把话说清楚：**没有实证上的最优阈值**。
 *
 * · 能确认的事实：主流 linter 都提供这类规则（ESLint 的 `max-lines` /
 *   `max-lines-per-function`、PMD 的 `ExcessiveClassLength` / `ExcessiveMethodLength`、
 *   Checkstyle 的 `FileLength`），说明"文件/函数过长"在工程上被当成需要管的坏味道；
 *   Fowler《Refactoring》把这组归为 Bloaters（Long Method / Large Class）。
 * · 但这些规则的**默认阈值各家差得很远**（数百到两千行都有，且随版本变），
 *   所以这里不去"引用"任何具体默认值 —— 引一个记错的数字比不引更糟。
 * · 下面这四个数是**按本仓库现状拍的经验值**（意见，不是结论），取舍理由写在每行后面：
 *   定得比现状严，就是为了让闸门"现在就能拦住继续变胖"，而不是等一个理想值。
 */
export const LIMITS = Object.freeze({
  // 800 行：其余文件已在 400–1500 之间，定 500 会让 8 个文件同时违规（一次还不完），
  // 定 2000 等于没闸。
  lines: 800,
  // 160 KB：中文注释让行数低估体量（bridge.js 793 KB / 14,360 行 ≈ 55 B/行）。
  bytes: 160 * 1024,
  // 120 行：现状最长 1043 行；120 已经是"明显该拆"的线，再宽松就失去意义。
  maxFunctionLines: 120,
  // 80 个方法：对应"一个类只该有一个变更理由"（SRP）；超过就是 God Class 的起点。
  maxClassMethods: 80,
})

/** 扫哪些文件：仓库里的源码，不含 node_modules / 产物。 */
const SCAN_DIRS = ['lib', 'tools', 'test', 'control', 'launcher']
const SCAN_EXT = /\.(js|mjs|cjs)$/
const SKIP_NAME = /^(node_modules|\.git|_tmp|dist|coverage)$/

/* ── 源码掩码：把注释/字符串/正则的内容换成空格，保持长度与换行 ─────────────── */

/**
 * 返回等长掩码串：注释、字符串、正则的内容变空格，其余原样。
 *
 * 为什么不能用 `src.replace(/\/\/.*$/gm, '')`：那会**改变行号与列号**，
 * 后面算"第几个 `}` 配平"就全错位了。等长替换是这里唯一能用的做法。
 */
export function maskSource(src, { keepStrings = false } = {}) {
  const out = src.split('')
  const n = src.length
  let i = 0
  let prevSignificant = ''   // 上一个非空白、非注释字符，用来判断 `/` 是除号还是正则开头
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }
    if (c === '/' && next === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1
      blank(i, Math.min(j + 2, n))
      i = Math.min(j + 2, n)
      continue
    }
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === quote) { j += 1; break }
        j += 1
      }
      // 模板串里的 ${...} 保守处理为整体掩掉：它内部的花括号不参与配平。
      // keepStrings 用于**依赖方向检查**：那时要看见 `from './bridge.js'` 的字面量。
      if (!keepStrings) blank(i + 1, Math.max(i + 1, j - 1))
      i = j
      prevSignificant = quote
      continue
    }
    // 正则字面量：`/` 前面不是标识符/括号/数字，才当正则开头。
    if (c === '/' && !/[\w$)\]]/.test(prevSignificant || '')) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        const ch = src[j]
        if (ch === '\\') { j += 2; continue }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) { j += 1; break }
        else if (ch === '\n') break
        j += 1
      }
      const flags = /^[a-z]*/.exec(src.slice(j, j + 6))?.[0] ?? ''
      blank(i + 1, Math.max(i + 1, j - 1))
      i = j + flags.length
      prevSignificant = '/'
      continue
    }
    if (!/\s/.test(c)) prevSignificant = c
    i += 1
  }
  return out.join('')
}

/** 定义行判定：顶层函数 / export 函数 / 类方法（缩进 ≤ 4）。 */
const DEF_RE = /^( {0,4})(export\s+)?(default\s+)?(async\s+)?(function\s*\*?\s*)?(static\s+)?(get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*\(/

/** 从 `from` 行开始找配平的 `}`，返回 { start, end }（0 基行号）。找不到返回 null。 */
function braceBlock(maskedLines, from) {
  let depth = 0
  let opened = false
  for (let i = from; i < maskedLines.length; i += 1) {
    const line = maskedLines[i]
    for (let k = 0; k < line.length; k += 1) {
      const ch = line[k]
      // 箭头函数的参数括号不算块，只有 `{` 才算；`(` 不参与。
      if (ch === '{') { depth += 1; opened = true }
      else if (ch === '}') {
        depth -= 1
        if (opened && depth === 0) return { start: from, end: i }
        if (depth < 0) return null
      }
    }
  }
  return null
}

/** 统计一个文件的行数/字节/最长函数/单类最多方法数。 */
export function measureSource(src, file = '') {
  const lines = src.split(/\r?\n/)
  const masked = maskSource(src).split(/\r?\n/)
  let maxFunctionLines = 0
  let maxFunctionName = ''
  /** @type {Map<number, {name: string, count: number}>} 缩进层级 → 该方法集合 */
  const classBuckets = new Map()

  for (let i = 0; i < masked.length; i += 1) {
    const line = masked[i]
    if (line.trim() === '') continue
    const m = DEF_RE.exec(line)
    if (m === null) continue
    const indent = m[1].length
    const name = m[8]
    // 排除 `if (…)` `for (…)` `while (…)` `switch (…)` `catch (…)` 这类控制语句：
    // 它们在掩码里也是"名字 + ("，但不是函数。
    if (/^(if|for|while|switch|catch|return|typeof|await|new|delete|void|in|of)$/.test(name)) continue
    // 必须有函数体的 `{`：跨行签名时往后找第一行含 `{` 的。
    let bodyAt = -1
    for (let j = i; j < Math.min(i + 8, masked.length); j += 1) {
      if (masked[j].includes('{')) { bodyAt = j; break }
      if (masked[j].includes(';')) break
    }
    if (bodyAt < 0) continue
    const block = braceBlock(masked, bodyAt)
    if (block === null) continue
    const size = block.end - i + 1
    if (size > maxFunctionLines) { maxFunctionLines = size; maxFunctionName = `${m[4] ?? ''}${name}` }
    // 类方法：缩进 2 且有配平块、名字不像构造函数以外的顶层函数。
    if (indent === 2) {
      const bucket = classBuckets.get(indent) ?? { name: '', count: 0 }
      bucket.count += 1
      classBuckets.set(indent, bucket)
    }
    i = block.end   // 跳过函数体，避免把内部箭头函数当成并列方法
  }

  const maxClassMethods = classBuckets.get(2)?.count ?? 0
  return {
    file,
    lines: lines.length,
    bytes: Buffer.byteLength(src, 'utf8'),
    maxFunctionLines,
    maxFunctionName,
    maxClassMethods,
  }
}

/* ── 扫文件树 ──────────────────────────────────────────────────────────────── */

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (SKIP_NAME.test(entry)) continue
    const full = join(dir, entry)
    let stat = null
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) walk(full, out)
    else if (SCAN_EXT.test(entry)) out.push(full)
  }
  return out
}

function collectFiles() {
  const files = []
  for (const dir of SCAN_DIRS) walk(join(REPO, dir), files)
  // 仓库根下零散的 .mjs 也扫（bio-clock 之类在 qq_chat，不在仓库里，跳过）
  return files.filter((f) => !f.includes(`${sep}node_modules${sep}`))
}

/* ── 判据 ──────────────────────────────────────────────────────────────────── */

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch {
    return { version: 1, limits: { ...LIMITS }, files: {} }
  }
}

function writeBaseline(data) {
  writeFileSync(BASELINE, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/**
 * 单文件判决。
 * @returns {{id: string, status: 'PASS'|'FAIL'|'NOTE', detail: string}[]}
 */
export function judge(measured, baseline, limits = LIMITS) {
  const key = measured.file
  const base = baseline.files?.[key]
  const out = []
  const dims = [
    ['lines', '行数'],
    ['bytes', '字节'],
    ['maxFunctionLines', '最长函数'],
    ['maxClassMethods', '单类方法数'],
  ]
  if (base === undefined) {
    for (const [field, label] of dims) {
      if (measured[field] > limits[field]) {
        out.push({
          id: `new:${field}`,
          status: 'FAIL',
          detail: `${key} ${label} ${measured[field]} > 限值 ${limits[field]}（新文件不得超标）`,
        })
      }
    }
    return out
  }
  for (const [field, label] of dims) {
    const limit = base[field] ?? 0
    if (measured[field] > limit) {
      out.push({
        id: `ratchet:${field}`,
        status: 'FAIL',
        detail: `${key} ${label} 从 ${limit} 涨到 ${measured[field]}（baseline 只许降不许升）`,
      })
    }
  }
  return out
}

/** 提取 import / export-from / 动态 import() 的说明符（注释已掩掉，字符串保留）。 */
export function importSpecs(src) {
  const code = maskSource(src, { keepStrings: true })
  const specs = []
  const patterns = [
    /\b(?:import|export)\b[^\n;]*?\bfrom\s*(['"])([^'"]+)\1/g,   // import x from './y'
    /^[ \t]*import\s*(['"])([^'"]+)\1/gm,                          // import './y'
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,                      // await import('./y')
  ]
  for (const re of patterns) {
    let m = re.exec(code)
    while (m !== null) {
      specs.push(m[2])
      m = re.exec(code)
    }
  }
  return [...new Set(specs)]
}

/**
 * 依赖方向闸门：**枝不许 import 干**。
 *
 * 这条规则才是"拆了不会粘回去"的保证。没有它，功能模块被切出去之后，
 * 下一个人想用 `this.#replyTo` 时顺手写一行 `import { QQBridge } from '../bridge.js'`，
 * 于是拆出去的枝又长出反向依赖 —— 结构图看着是分层的，依赖图已经回到一团。
 *
 * 唯一豁免：`lib/index.js`（根 → 干，本来就是装配处）。`lib/bridge*` 内部随便引。
 * 正确做法是让干把能力作为**端口对象**传进去（Cockburn 的 Ports & Adapters）：
 *   export function handleOps(port, message, text)   // port = { reply, callAction, config }
 * 而不是让枝去 import 干的类。
 *
 * 判据只认文件名（`./bridge.js` / `../bridge.js` / `./bridge/x.js`）——
 * 这是行数级静态检查，不做模块图解析，所以宁可简单也不能骗人。
 */
export function judgeImports(relFile, src) {
  const path = relFile.split('\\').join('/')
  if (!path.startsWith('lib/')) return []
  const base = path.slice('lib/'.length)
  if (base === 'index.js') return []
  if (base === 'bridge.js' || base.startsWith('bridge/')) return []
  const out = []
  for (const spec of importSpecs(src)) {
    if (!spec.startsWith('.')) continue
    const toTrunk = /(^|\/)bridge(\.js)?$/.test(spec) || /(^|\/)bridge\//.test(spec)
    if (!toTrunk) continue
    out.push({
      id: 'deps:branch-to-trunk',
      status: 'FAIL',
      detail: `${path} import 了 ${spec}（枝不许依赖干；改成接收端口对象）`,
    })
  }
  return out
}

/* ── 自检：三种已知材料，闸门必须都判对 ─────────────────────────────────────── */

function selftest() {
  /**
   * 每个用例自带限值：**一份材料只该触发一个维度**。
   * 第一版把 lines 定成 10，结果"函数过长"那条同时超了行数 —— 测试材料的错，
   * 会让人误以为闸门分不清主次（fixture 本身也是判据的一部分）。
   */
  const cases = [
    {
      name: '合规文件（必须一条 FAIL 都没有）',
      limits: { lines: 10, bytes: 400, maxFunctionLines: 5, maxClassMethods: 2 },
      src: 'const a = 1\nfunction f() {\n  return a\n}\n',
      expect: [],
    },
    {
      name: '恰好超一行（只有 lines 该 FAIL）',
      limits: { lines: 10, bytes: 4000, maxFunctionLines: 5, maxClassMethods: 2 },
      src: 'x\n'.repeat(11),
      expect: ['new:lines'],
    },
    {
      name: '函数过长（只有 maxFunctionLines 该 FAIL）',
      limits: { lines: 30, bytes: 4000, maxFunctionLines: 5, maxClassMethods: 2 },
      src: 'class A {\n  f() {\n' + '    a()\n'.repeat(6) + '  }\n}\n',
      expect: ['new:maxFunctionLines'],
    },
    {
      name: '类方法过多（只有 maxClassMethods 该 FAIL）',
      limits: { lines: 40, bytes: 4000, maxFunctionLines: 10, maxClassMethods: 2 },
      src: 'class A {\n  a() {\n  }\n  b() {\n  }\n  c() {\n  }\n}\n',
      expect: ['new:maxClassMethods'],
    },
  ]
  let bad = 0
  for (const testCase of cases) {
    const m = measureSource(testCase.src, '(selftest)')
    const got = judge(m, { files: {} }, testCase.limits).map((r) => r.id)
    const want = testCase.expect
    const same = got.length === want.length && want.every((id) => got.includes(id))
    console.log(`${same ? 'PASS' : 'FAIL'} selftest: ${testCase.name}`, same ? '' : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
    if (!same) bad += 1
  }
  // 掩码必须验：注释/字符串/正则里的花括号不能被算进配平。
  const tricky = 'function f() {\n  const s = "}{"\n  const r = /a{2,3}/\n  return 1\n}\nfunction g() {\n  return 2\n}\n'
  const m = measureSource(tricky, '(selftest)')
  const ok = m.maxFunctionLines === 5
  console.log(`${ok ? 'PASS' : 'FAIL'} selftest: 字符串/正则里的花括号不干扰配平`, `maxFunctionLines=${m.maxFunctionLines}（应为 5）`)
  if (!ok) bad += 1
  // 依赖方向：正反两面都要验（只验一面等于恒真）。
  const importCases = [
    { name: '枝 import 干（必须拦）', file: 'lib/ops.js', src: 'import { QQBridge } from \'./bridge.js\'\n', expect: true },
    { name: '枝 import 干（多级路径也要拦）', file: 'lib/commands/x.js', src: 'import { a } from \'../bridge.js\'\n', expect: true },
    { name: '根 import 干（必须放）', file: 'lib/index.js', src: 'import { QQBridge } from \'./bridge.js\'\n', expect: false },
    { name: '枝 import 兄弟模块（必须放）', file: 'lib/ops.js', src: 'import { plan } from \'./ops-core.js\'\n', expect: false },
    { name: '注释里的 import 不算（必须放）', file: 'lib/ops.js', src: '// import { QQBridge } from \'./bridge.js\'\nconst a = 1\n', expect: false },
  ]
  for (const testCase of importCases) {
    const got = judgeImports(testCase.file, testCase.src).length > 0
    const pass = got === testCase.expect
    console.log(`${pass ? 'PASS' : 'FAIL'} selftest: ${testCase.name}`, pass ? '' : `got=${got} want=${testCase.expect}`)
    if (!pass) bad += 1
  }
  return bad === 0
}

/* ── 主流程 ────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  return {
    asJson: argv.includes('--json'),
    ratchet: argv.includes('--ratchet'),
    init: argv.includes('--init'),
    selftest: argv.includes('--selftest'),
  }
}

/** 扫仓库并逐个测量。返回 `{ file, lines, bytes, ... }[]`（file 是仓库相对路径） */
function measureAll() {
  const measured = []
  for (const file of collectFiles().sort()) {
    let src = ''
    /**
     * ⚠️ 读进来先归一化行尾（2026-11-18）。
     *
     * 仓库 `.gitattributes` 写死 `eol=lf`，但**编辑器/脚本可能把工作区写成 CRLF**
     * （我自己用 Python 改文件就踩了：`open(...,'w')` 在 Windows 默认 CRLF）。
     * 那时 `Buffer.byteLength` 每行多算 1 字节 —— 420 行的文件凭空涨 420 字节，
     * 闸门报「字节变大」，而 `git diff` 归一化后**看不出任何改动**，极难反查。
     * 归一化之后，这道闸只量内容、不量行尾。
     */
    try { src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n') } catch { continue }
    measured.push(measureSource(src, relative(REPO, file).split(sep).join('/')))
  }
  return measured
}

/**
 * 一次性初始化：把**当前已经超标**的文件登记成技术债。
 *
 * 只在 baseline 为空时允许 —— 否则它就成了 `--ratchet` 的后门
 * （把涨上去的值重新登记一遍，闸门等于没有）。
 */
function runInit(measured, limits) {
  const baseline = readBaseline()
  if (Object.keys(baseline.files ?? {}).length > 0) {
    console.error('拒绝 --init：baseline 已经有内容了。要收紧请用 --ratchet（只许降）。')
    return 1
  }
  const next = { version: 1, updatedAt: new Date().toISOString(), limits, files: {} }
  for (const row of measured) {
    const excess = ['lines', 'bytes', 'maxFunctionLines', 'maxClassMethods'].filter((f) => row[f] > limits[f])
    if (excess.length === 0) continue
    next.files[row.file] = {
      lines: row.lines,
      bytes: row.bytes,
      maxFunctionLines: row.maxFunctionLines,
      maxFunctionName: row.maxFunctionName,
      maxClassMethods: row.maxClassMethods,
    }
  }
  writeBaseline(next)
  console.log(`baseline 已初始化：${Object.keys(next.files).length} 个超标文件登记为技术债（只许降）`)
  return 0
}

/** 只收紧：任何维度变大就拒绝写入，逼人先改代码（这是 ratchet 的全部意义）。 */
function runRatchet(measured, baseline, limits) {
  const next = { version: 1, updatedAt: new Date().toISOString(), limits, files: { ...baseline.files } }
  const refused = []
  for (const row of measured) {
    const prev = next.files[row.file]
    if (prev === undefined) {
      const excess = ['lines', 'bytes', 'maxFunctionLines', 'maxClassMethods'].filter((f) => row[f] > limits[f])
      // 合规的新文件不该进 baseline；超限的新文件要先去拆。
      if (excess.length > 0) refused.push(`${row.file}: 不在 baseline 里却超限（${excess.join('/')}），先拆再登记`)
      continue
    }
    const grown = ['lines', 'bytes', 'maxFunctionLines', 'maxClassMethods'].filter((f) => row[f] > (prev[f] ?? 0))
    if (grown.length > 0) {
      refused.push(`${row.file}: ${grown.join('/')} 变大，拒绝收紧（先改代码）`)
      continue
    }
    next.files[row.file] = {
      lines: row.lines,
      bytes: row.bytes,
      maxFunctionLines: row.maxFunctionLines,
      maxFunctionName: row.maxFunctionName,
      maxClassMethods: row.maxClassMethods,
    }
  }
  if (refused.length > 0) {
    console.error('ratchet 被拒绝：')
    for (const r of refused) console.error(`  · ${r}`)
    return 1
  }
  writeBaseline(next)
  console.log(`baseline 已收紧：${Object.keys(next.files).length} 个文件`)
  return 0
}

/** 检查并打印。返回退出码。 */
function runCheck(measured, baseline, limits, asJson) {
  const findings = []
  for (const row of measured) {
    findings.push(...judge(row, baseline, limits))
    if (row.file.startsWith('lib/')) {
      let src = ''
      try { src = readFileSync(join(REPO, row.file), 'utf8') } catch { /* 读不到就跳过 */ }
      findings.push(...judgeImports(row.file, src))
    }
  }
  const fails = findings.filter((f) => f.status === 'FAIL')

  // 提示可以收紧的（不作为失败）：任一超限文件已明显变小。
  const tips = []
  for (const row of measured) {
    const base = baseline.files?.[row.file]
    if (base === undefined) continue
    const shrink = ['lines', 'bytes', 'maxFunctionLines', 'maxClassMethods'].filter(
      (f) => (base[f] ?? 0) > 0 && row[f] <= Math.floor((base[f] ?? 0) * 0.98),
    )
    if (shrink.length > 0) tips.push(`${row.file} 变小了（${shrink.join('/')}）—— 可以 node tools/module-gate.mjs --ratchet 收紧`)
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: fails.length === 0, limits, scanned: measured.length, findings, tips }, null, 2))
    return fails.length === 0 ? 0 : 1
  }

  console.log(`\n模块规模闸门 · ${measured.length} 个文件 · 限值 ${limits.lines} 行 / ${Math.round(limits.bytes / 1024)} KB / 函数 ${limits.maxFunctionLines} 行 / 单类 ${limits.maxClassMethods} 方法`)
  console.log('─'.repeat(78))
  if (fails.length === 0) {
    console.log('PASS 全部在 baseline 之内（ratchet 生效：只许降不许升）')
  } else {
    for (const f of fails) console.log(`FAIL ${f.detail}`)
  }
  const debt = measured
    .filter((r) => baseline.files?.[r.file] !== undefined)
    .sort((a, b) => b.lines - a.lines)
  if (debt.length > 0) {
    console.log('─'.repeat(78))
    console.log('已登记的技术债（按行数排序，只许降）：')
    for (const row of debt) {
      const base = baseline.files[row.file]
      const delta = row.lines - base.lines
      console.log(`  ${String(row.lines).padStart(6)} 行  ${row.file}${delta < 0 ? `  ↓${-delta}` : ''}`)
    }
  }
  if (tips.length > 0) {
    console.log('─'.repeat(78))
    for (const tip of tips) console.log(`NOTE ${tip}`)
  }
  console.log('')
  return fails.length === 0 ? 0 : 1
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.selftest) process.exit(selftest() ? 0 : 2)
  const baseline = readBaseline()
  const limits = { ...LIMITS, ...(baseline.limits ?? {}) }
  const measured = measureAll()
  if (args.init) process.exit(runInit(measured, limits))
  if (args.ratchet) process.exit(runRatchet(measured, baseline, limits))
  process.exit(runCheck(measured, baseline, limits, args.asJson))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
