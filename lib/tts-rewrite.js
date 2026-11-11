/**
 * 朗读改写层（2026-11-11）。
 *
 * 问题：她一条一句、6–15 字，edge-tts 念短句必然是平的（没有起伏空间）。
 * 用户不想改人设（会影响聊天体验），所以**只在送 TTS 之前**把短句合并成一段。
 *
 * 做法：调一个 OpenAI 兼容的本地模型（默认 Ollama `qwen2.5:3b`），
 * prompt 明确"只合并、加逗号、加语气词，不添加新信息"。
 *
 * 三条硬约束：
 * ① **只影响语音**——文字消息发的还是原文，用户看到的没变；
 * ② **失败就用原文**——超时/空输出/带换行/超长，全部退回原文，绝不因为改写失败而不发语音；
 * ③ **默认关闭**——`ttsRewriteEnabled` 打开才走，不打开时零开销、零依赖。
 */

/** 默认改写指令：实测 qwen2.5:3b 按这个能给出「等你呢，刚才一直在看门口，还以为你今天不来了。」 */
export const DEFAULT_REWRITE_PROMPT =
  '把用户给的多句短句合并成一句话：用逗号连接，保留每一句的原意，可以加口语语气词，不加新信息。只输出这一句话，不要引号、不要解释。'

/**
 * 把本轮回复改写成"适合念"的一段话。
 *
 * @returns {Promise<string>} 改写后的文本；任何异常都返回原文。
 */
export async function rewriteForTts(config, text, { emotion = '' } = {}) {
  const source = String(text ?? '').trim()
  if (config.ttsRewriteEnabled !== true) return source
  if (source === '') return source

  const base = String(config.ttsRewriteBaseUrl || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '')
  const model = String(config.ttsRewriteModel || 'qwen2.5:3b')
  const timeoutMs = Math.max(1000, Number(config.ttsRewriteTimeoutMs) || 8000)
  const prompt = String(config.ttsRewritePrompt || DEFAULT_REWRITE_PROMPT)

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          // 情绪只在有值时提示，避免改写器自己发挥
          { role: 'user', content: emotion ? `（情绪：${emotion}）${source}` : source },
        ],
        temperature: 0.2,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return source
    const data = await response.json()
    const out = String(data?.choices?.[0]?.message?.content ?? '').trim()
    // 基本校验：非空、单行、不超长；任何一条不满足就退回原文
    if (out === '' || out.length > 200 || /[\r\n]/.test(out)) return source
    return out
  } catch {
    return source
  }
}
