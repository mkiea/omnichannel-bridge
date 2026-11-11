/**
 * 朗读改写层（2026-11-11）。
 *
 * 锁五件事：
 *   ① 默认关闭时**一个请求都不发**（零开销）；
 *   ② 正常返回时用改写结果；
 *   ③ 非 200 / 抛错 / 超时 → **退回原文**（绝不因为改写失败而丢语音）；
 *   ④ 输出带换行或超长 → 退回原文（防止模型输出解释）；
 *   ⑤ 空文本不请求。
 */
import { rewriteForTts, DEFAULT_REWRITE_PROMPT } from '../lib/tts-rewrite.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const originalFetch = globalThis.fetch
let calls = 0
let lastBody = null

function mockFetch(handler) {
  calls = 0
  lastBody = null
  globalThis.fetch = async (url, init) => {
    calls++
    lastBody = { url: String(url), body: JSON.parse(init.body) }
    return handler()
  }
}
const jsonResponse = (content, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ choices: [{ message: { content } }] }),
})

const ON = { ttsRewriteEnabled: true, ttsRewriteBaseUrl: 'http://127.0.0.1:11434/v1', ttsRewriteModel: 'qwen2.5:3b' }
const TEXT = '等你呢。刚才一直在看门口。还以为你今天不来了。'

// ① 默认关闭
mockFetch(() => jsonResponse('不该被调用'))
const off = await rewriteForTts({ ttsRewriteEnabled: false }, TEXT)
check('关闭时不发请求、原样返回', off === TEXT && calls === 0, `calls=${calls}`)

// ② 正常改写
mockFetch(() => jsonResponse('等你呢，刚才一直在看门口，还以为你今天不来了。'))
const on = await rewriteForTts(ON, TEXT)
check('开启时使用改写结果', on === '等你呢，刚才一直在看门口，还以为你今天不来了。', on)
check('请求打到 /chat/completions', lastBody?.url.endsWith('/chat/completions'), lastBody?.url)
check('默认 prompt 被带进 system', lastBody?.body?.messages?.[0]?.content === DEFAULT_REWRITE_PROMPT, String(lastBody?.body?.messages?.[0]?.content).slice(0, 40))

// ③ 失败回退
mockFetch(() => jsonResponse('', 500))
check('非 200 → 退回原文', (await rewriteForTts(ON, TEXT)) === TEXT)
mockFetch(() => { throw new Error('boom') })
check('抛错 → 退回原文', (await rewriteForTts(ON, TEXT)) === TEXT)

// ④ 输出不合法
mockFetch(() => jsonResponse('第一句\n第二句'))
check('带换行 → 退回原文', (await rewriteForTts(ON, TEXT)) === TEXT)
mockFetch(() => jsonResponse('啊'.repeat(300)))
check('超长（>200）→ 退回原文', (await rewriteForTts(ON, TEXT)) === TEXT)
mockFetch(() => jsonResponse('   '))
check('空白输出 → 退回原文', (await rewriteForTts(ON, TEXT)) === TEXT)

// ⑤ 空文本
mockFetch(() => jsonResponse('不该被调用'))
const empty = await rewriteForTts(ON, '   ')
check('空文本不请求', empty === '' && calls === 0, `calls=${calls}`)

globalThis.fetch = originalFetch
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
