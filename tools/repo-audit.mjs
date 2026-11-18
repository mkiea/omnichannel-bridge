/**
 * repo-audit.mjs —— 推送前审计：这个仓库里有没有不该公开的东西（2026-11-17）
 *
 * 起因：主人说「**不要推送主要研究内容，要降级推送**」。
 * 这个仓库是**公开的**（github.com/mkiea/qq-integration），所以"推错东西"是不可逆的。
 *
 * 靠人记是记不住的 —— 已经犯过两次：`_tmp-msg.txt` 误入版本库两次、
 * `_tmp-testall13.log` 一次、真实 QQ 号写进 CHANGELOG 一次。所以做成脚本，
 * 挂在 `tools/verify.mjs` 的第 0 关（最快、最先跑）。
 *
 * 检查四类：
 *   ① 真实账号   —— 10 位 QQ 号（测试用的 2000000001 这类在白名单里）
 *   ② 本机路径   —— C:\Users\<名字>、/home/<名字>（泄露机器名与目录结构）
 *   ③ 密钥形态   —— sk- / AKIA / ghp_ / 私钥块
 *   ④ 研究资产   —— 模型权重、训练脚本、数据集、人设文档、DiffSinger 工程
 *
 * 用法：
 *   node tools/repo-audit.mjs           # 人读
 *   node tools/repo-audit.mjs --json    # 机器读
 *   node tools/repo-audit.mjs --staged  # 只看暂存区（提交前）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const stagedOnly = argv.includes('--staged')

/** 测试/示例里合法出现的假号码 —— 加进来要写清为什么。 */
/**
 * 只放**确定是编的**号码。2026-11-17 教训：我一开始把某个**真实群号**当"测试群号"写进来，
 * 结果它是**真实群号**（`privacy-unit` 当场抓到）—— 白名单本身成了泄露面。
 * 现在这条规矩：**不确定的一律不放**；`test/` 目录另有 ALLOW，不需要在这里豁免。
 */
const FAKE_IDS = new Set([
  '2000000001', '2000000002', '2000000003',   // 测试里的普通用户
  '3000000001', '3000000002',                 // 测试里的机器人号
])

/** ① 真实账号：10 位、以 3 开头的连续数字（QQ 号的实际形态）。 */
// ⚠️ 不用 `\b`：`_` 是词字符，`u_<数字>` 这种写法会被 `\b` 漏掉（2026-11-17 实测）
const QQ_RE = /(?<![0-9])(3\d{9})(?![0-9])/g

/** ② 本机路径。 */
const PATH_RE = /(?:[A-Za-z]:\\\\?Users\\\\?|\/home\/|\/Users\/)([A-Za-z0-9_.-]{2,32})/g

/** ③ 密钥形态（原则：宁可多看几眼，不可漏）。 */
const SECRET_PATTERNS = [
  [/\bsk-(?!ant-|dlp|test)[A-Za-z0-9_-]{16,}/g, 'OpenAI 风格密钥'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, 'Anthropic 密钥'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS Access Key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'GitHub token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '私钥块'],
]

/** ④ 研究资产：这些东西出现在公开仓库就等于发布。 */
const RESEARCH_PATTERNS = [
  [/\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i, '模型权重'],
  [/\.ustx$/i, 'DiffSinger 工程'],
  [/^(models|datasets?|train(ing)?|eval|experiments?)\//i, '研究目录'],
  // ⚠️ 只认**人设目录**与 role_spec：`docs/PERSONA.md` 是"怎么写人设"的说明、
  // `lib/persona-spec.js` 是校验器代码 —— 两者都是工具，不是设定本身（2026-11-17 误报过）
  [/(^|\/)personas?\//i, '人设目录'],
  [/(^|\/)role_spec/i, '人设规格'],
  [/(^|\/)AGENTS\.md$/i, '人设/工作约定'],
  [/\.jsonl$/i, '对话/数据集'],
  /**
   * ⑤ **内部研究词汇**：代码里出现这些词，等于把研究框架讲给公开仓库听。
   * 2026-11-17 实测抓到过：`lib/emotion-state.js` 引用「设计/七情六欲…§4.2/§4.3」、
   * `lib/tts.js` 写「正向被**依恋类型**压制」—— 功能代码可以公开，研究依据不必。
   * 判据是"这个词只在研究文档里出现"，不是"含中文"。
   */
]

/**
 * ⑤ **内部研究词汇**：只能扫**正文**（扫文件名没意义）。
 * 2026-11-18 外部审计指出：原来这条混在 RESEARCH_PATTERNS 里、而那段循环只对 `file`
 * 跑 `re.test(file)` ⇒ **正文里的研究文档章节永远不会被报**，而 `--selftest`
 * 拿正文样本测它又是绿的 —— 自检绿、实扫空。现在分开：文件名规则 / 正文规则。
 */
const RESEARCH_TEXT_PATTERNS = [
  [/(设计\/七情六欲|七情六欲|依恋类型|主体是人|猫性层|消融实验|预注册)/, '内部研究词汇'],
]

/** 白名单：这些文件允许出现上面的东西（都要写理由）。 */
const ALLOW = [
  { file: /^test\//, why: '测试 fixture 必须带样例；真实号已在 FAKE_IDS 排除' },
  { file: /^lib\/redact\.js$/, why: '脱敏规则本身要含密钥形态（否则测不出来）' },
  { file: /^test\/platform-adapter-unit\.mjs$/, why: '契约测试里列方法名' },
  { file: /^docs\/ADAPTER\.md$/, why: '文档里举能力名' },
  // 这几份**定义**"什么算研究词汇"，必然包含这些词本身
  { file: /^docs\/PRIVACY(-HANDOFF)?\.md$/, why: '隐私手册在定义判据' },
  { file: /^docs\/REDTEAM(-HANDOFF)?\.md$/, why: '攻击手册在定义判据' },
  { file: /^tools\/repo-audit\.mjs$/, why: '审计工具本身就是规则的载体' },
  // CHANGELOG 是历史记录，**只豁免拟人指代这类噪音**；真实号/密钥仍然必须报。
  { file: /^CHANGELOG\.md$/, why: '历史记录（仅豁免拟人类噪音）', skipKinds: ['内部研究词汇'] },
]

function listFiles() {
  const args = stagedOnly ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files']
  const out = execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

function isAllowed(file, kind = '') {
  return ALLOW.some((a) => a.file.test(file) && !(Array.isArray(a.skipKinds) && a.skipKinds.includes(kind)))
}

function scan() {
  const files = listFiles()
  const hits = []
  for (const file of files) {
    // ④ 先按**文件名**判研究资产（不用读内容）
    for (const [re, label] of RESEARCH_PATTERNS) {
      if (re.test(file) && !isAllowed(file)) {
        hits.push({ file, kind: label, level: 'red', detail: '文件名命中研究资产' })
      }
    }
    // ①②③ 按内容判（跳过二进制与超大文件）
    let text = ''
    try {
      const full = join(REPO, file)
      const buf = readFileSync(full)
      if (buf.length > 2 * 1024 * 1024) continue
      text = buf.toString('utf8')
    } catch { continue }
    if (text.includes('\u0000')) continue   // 二进制

    if (!isAllowed(file)) {
      for (const m of text.matchAll(QQ_RE)) {
        if (!FAKE_IDS.has(m[1])) {
          hits.push({ file, kind: '真实 QQ 号', level: 'red', detail: m[1], line: lineOf(text, m.index) })
        }
      }
      for (const m of text.matchAll(PATH_RE)) {
        // 文档与测试里的示例用户名（user / someone / example / yourname）不算泄露
        if (!['Public', 'Default', 'user', 'someone', 'example', 'yourname', 'xxx'].includes(m[1])) {
          hits.push({ file, kind: '本机路径', level: 'yellow', detail: m[0], line: lineOf(text, m.index) })
        }
      }
    }
    if (!isAllowed(file)) {
      for (const [re, label] of RESEARCH_TEXT_PATTERNS) {
        if (re.test(text)) hits.push({ file, kind: label, level: 'red', detail: '正文命中研究词汇', line: lineOf(text, text.search(re)) })
      }
    }
    for (const [re, label] of SECRET_PATTERNS) {
      const g = new RegExp(re.source, re.flags)
      for (const m of text.matchAll(g)) {
        // 脱敏库自己的规则串不算泄露（它就是靠这些形态工作的）
        if (file === 'lib/redact.js') continue
        // test/ 与 admin-commands 的 !dlptest 样例是**故意**放进去的（否则测不出脱敏），
        // 降成 🟡：仍然看一眼，但不阻止推送。
        const level = (file.startsWith('test/') || file === 'lib/admin-commands.js') ? 'yellow' : 'red'
        hits.push({ file, kind: label, level, detail: `${m[0].slice(0, 12)}…`, line: lineOf(text, m.index) })
      }
    }
  }
  return { files: files.length, hits }
}

function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') n += 1
  return n
}

/**
 * `--selftest`：喂三种材料验证规则本身（有差异 / 无差异 / 该命中的）。
 * 2026-11-16 的教训：**新加的判据必须先用已知会被污染的样本测过**，否则不知道它能不能看见。
 */
if (argv.includes('--selftest')) {
  const samples = [
    ['设计/七情六欲与猫特征融合.md', true, '研究目录'],
    ['正向被依恋类型压制', true, '依恋类型'],
    ['u_1234567890', false, '普通占位'],
    ['今天天气不错', false, '普通中文'],
  ]
  let bad = 0
  for (const [text, shouldHit, label] of samples) {
    // 三个数组都要测：文件名规则 + 正文规则 + 密钥规则（否则改了结构、自检还在测旧的）
    const hit = [...RESEARCH_PATTERNS, ...RESEARCH_TEXT_PATTERNS, ...SECRET_PATTERNS]
      .some(([re]) => new RegExp(re.source, re.flags.replace('g', '')).test(text))
    const ok = hit === shouldHit
    if (!ok) bad += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(text)} → 命中=${hit}（期望 ${shouldHit}）`)
  }
  /**
   * ★ 2026-11-18 外部审计的核心教训：**自检和实扫必须同源**。
   *
   * 原来 `--selftest` 拿**正文样本**去测 `RESEARCH_PATTERNS`（绿的），
   * 而 `scan()` 里那段循环只对**文件名**跑 `re.test(file)` ⇒ 自检绿、实扫空，
   * `docs/` 正文里的研究词汇永远不会被报。
   *
   * 这条断言钉住"研究词汇规则确实被用在了 text 上"，而不是只在自检里被用。
   */
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const usedOnText = /for\s*\(\s*const\s*\[re,\s*label\]\s*of\s*RESEARCH_TEXT_PATTERNS\s*\)\s*\{\s*\n\s*if\s*\(re\.test\(text\)/.test(self)
  console.log(`${usedOnText ? 'PASS' : 'FAIL'} 研究词汇规则真的扫正文（不是只扫文件名）`)
  if (!usedOnText) bad += 1

  // 号码正则：`u_<号>` 必须能被抓到（这就是 2026-11-17 那个 \b 的坑）
  const qq = /(?<![0-9])(3\d{9})(?![0-9])/.test('u_3000000001')   // 用编的号，别拿真的当样本
  console.log(`${qq ? 'PASS' : 'FAIL'} 下划线拼号能被抓（\b 的坑）`)
  if (!qq) bad += 1
  process.exit(bad === 0 ? 0 : 1)
}

const { files: fileCount, hits } = scan()
const red = hits.filter((h) => h.level === 'red')
const yellow = hits.filter((h) => h.level === 'yellow')

if (asJson) {
  console.log(JSON.stringify({ files: fileCount, red: red.length, yellow: yellow.length, hits }, null, 2))
} else {
  console.log(`\n推送前审计 · ${fileCount} 个已跟踪文件`)
  console.log('─'.repeat(72))
  if (hits.length === 0) {
    console.log('✅ 没发现真实账号 / 本机路径 / 密钥 / 研究资产')
  } else {
    for (const h of red) console.log(`🔴 ${h.kind}  ${h.file}${h.line ? `:${h.line}` : ''}  ${h.detail}`)
    for (const h of yellow) console.log(`🟡 ${h.kind}  ${h.file}${h.line ? `:${h.line}` : ''}  ${h.detail}`)
    const byKind = {}
    for (const h of hits) byKind[h.kind] = (byKind[h.kind] || 0) + 1
    console.log('─'.repeat(72))
    console.log(Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join('  '))
    if (red.length > 0) {
      console.log('\n🔴 不能推。处理方式：脱敏 / 移出仓库 / 加进 .gitignore，然后重跑。')
    } else {
      console.log('\n🟡 可以推，但看一眼上面这些路径是不是你不想公开的。')
    }
  }
  console.log('')
}

process.exit(red.length > 0 ? 1 : 0)
