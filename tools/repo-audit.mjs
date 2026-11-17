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
]

/** 白名单：这些文件允许出现上面的东西（都要写理由）。 */
const ALLOW = [
  { file: /^test\//, why: '测试 fixture 必须带样例；真实号已在 FAKE_IDS 排除' },
  { file: /^lib\/redact\.js$/, why: '脱敏规则本身要含密钥形态（否则测不出来）' },
  { file: /^test\/platform-adapter-unit\.mjs$/, why: '契约测试里列方法名' },
  { file: /^docs\/ADAPTER\.md$/, why: '文档里举能力名' },
  { file: /^CHANGELOG\.md$/, why: '历史记录；已脱敏，保留以维持时间线' },
]

function listFiles() {
  const args = stagedOnly ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files']
  const out = execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

function isAllowed(file) {
  return ALLOW.some((a) => a.file.test(file))
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
