/**
 * TTS synthesis: Azure Speech (SSML), any OpenAI-compatible /audio/speech endpoint,
 * or a local GPT-SoVITS api_v2 server (zero-shot voice cloning).
 * Returns { audio: Buffer, format: 'mp3' | 'wav' }.
 *
 * 2026-11-04 加了「唱歌」：不是真正的歌声合成（Azure 没有 singing 风格），
 * 而是把歌词切成一句一个 `<s>`、每句套不同的 pitch/rate —— **一次合成、不拼音频**。
 * 为什么不做多段拼接：mp3 每段都有自己的头，直接 concat 很多播放器只播第一段。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 常用中文音色（Azure）。不是全表 —— Azure 有几百个，全列出来没法选。
 * 挑的是听感差异明显的；`!音色 <完整名字>` 仍然可以直接填表外的。
 */
export const VOICE_CATALOG = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', tag: '女 · 温暖自然（默认）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', tag: '女 · 活泼年轻' },
  { id: 'zh-CN-XiaochenNeural', name: '晓辰', tag: '女 · 随性闲聊' },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵', tag: '女 · 温柔沉稳' },
  { id: 'zh-CN-XiaomengNeural', name: '晓梦', tag: '女 · 俏皮' },
  { id: 'zh-CN-XiaomoNeural', name: '晓墨', tag: '女 · 成熟' },
  { id: 'zh-CN-XiaoruiNeural', name: '晓睿', tag: '女 · 清冷' },
  { id: 'zh-CN-XiaoshuangNeural', name: '晓双', tag: '女童 · 童声' },
  { id: 'zh-CN-YunxiNeural', name: '云希', tag: '男 · 阳光少年' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', tag: '男 · 新闻播报' },
  { id: 'zh-CN-YunjianNeural', name: '云健', tag: '男 · 沉稳解说' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', tag: '男童 · 童声' },
]

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildAzureSsml(text, voice, style) {
  const styleAttr = style ? ` style="${escapeXml(style)}"` : ''
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${escapeXml(voice)}"${styleAttr}>${escapeXml(text)}</voice></speak>`
}

/**
 * 把回复文本整理成「适合朗读」的形状（2026-11-08）。
 *
 * 为什么需要：回复里常带 markdown（`**重点**`、`[链接](url)`、代码块、列表符号），
 * TTS 会把 `*`、`#`、括号里的 URL 一起念出来；句子没有句末标点时，TTS 会一口气拖到底，
 * 听起来就是「念稿」。这里只做**不改变语义**的处理：去标记、换行当句号、补句末、按句截断。
 *
 * 不做的事：不改写措辞、不加语气词（那属于人设，不该在 TTS 层偷偷改）。
 */
export function normalizeSpeechText(text, { maxChars = 0 } = {}) {
  let s = String(text ?? '')
  if (s.trim() === '') return ''
  s = s.replace(/```[\s\S]*?```/g, '。')          // 代码块直接略过，别逐字符念
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // 图片整体丢掉
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // 链接只留文字
  s = s.replace(/[*_~#>|]/g, '')
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\s*\n+\s*/g, '。')               // 换行 = 句读，别连读
  s = s.replace(/。{2,}/g, '。').replace(/，{2,}/g, '，')
  s = s.trim().replace(/^[，。；：、]+/, '')
  if (s !== '' && !/[。！？?!…]$/.test(s)) s += '。'
  if (maxChars > 0 && s.length > maxChars) {
    // 按句截断：宁可少念一句，也不要在词中间切断（那听起来像断气）
    const cut = s.slice(0, maxChars)
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'))
    s = at >= Math.max(4, Math.floor(maxChars * 0.4)) ? cut.slice(0, at + 1) : `${cut}……`
  }
  return s
}

/**
 * 按语气给整段语音挑一组 rate/pitch（2026-11-08）。
 *
 * 依据：ChinaMM 2026 那篇指出，TTS 在**缺少显式约束时会回归均值**——生成统计上安全、
 * 但平均且平的语调。edge-tts 又不让插 `<break>`/`express-as`（官方移除了自定义 SSML），
 * 所以能给的最低成本「显式约束」只有两个整段标量：语速与音高。
 *
 * 取值克制在 ±4% / ±3Hz：社区实测里情感拉满（styledegree > 1.2 那一档）会像话剧；
 * 这里的目的是「别每条都一样」，不是演。
 * `jitter` 默认开：同一句话每次也略有不同——真人不会两次一模一样。
 */
export function pickProsody(text, { rng = Math.random, jitter = true } = {}) {
  const s = String(text ?? '').trim()

  /**
   * 情绪词表（2026-11-10，按「软软」这个人设写的）。
   *
   * 为什么先看词、再看标点：edge-tts 没有情感模型，「委屈」和「困」的唯一区别
   * 就是语速/音高/音量同时往下走；只按标点分不出来（两句都可能是句号结尾）。
   * 这些词是从她的人设口癖里挑的（抱抱/想你了/嘛/诶嘿/可以等/困/呼），
   * 不是通用情感分类——**换人设就要重写这张表**。
   *
   * 顺序 = 优先级：先强烈的（委屈/困），再撒娇/开心，最后才轮到标点。
   */
  const MOODS = [
    { mood: 'sad', re: /你是不是|可以等|不要走|不理我|被丢下|呜/, rate: -8, pitch: -4, volume: -15 },
    { mood: 'sleepy', re: /好困|困了|想睡|晚安|呼[……]|好累/, rate: -10, pitch: -4, volume: -15 },
    { mood: 'shy', re: /不知道|才不是|小声|……嘛|人家/, rate: -6, pitch: -3, volume: -12 },
    { mood: 'coax', re: /抱抱|亲亲|想你了|陪我|贴贴|要要|嘛[。！？…~～]?\s*$/, rate: -4, pitch: 6, volume: -5 },
    { mood: 'happy', re: /诶嘿|好耶|哈哈|开心|太棒|回来啦/, rate: 4, pitch: 4, volume: 3 },
    // 整句只有「哼/哦/随便」才算假装生气；句首的「哼，……」是娇嗔，留给后面的标点规则
    { mood: 'sulk', re: /^(哼|哦|随便)[。！？…~～]?$/, rate: -2, pitch: -2, volume: 0 },
  ]

  let rate = 0
  let pitch = 0
  let volume = 0
  let mood = 'plain'

  const hit = MOODS.find((rule) => rule.re.test(s))
  if (hit) {
    ({ mood, rate, pitch, volume } = hit)
  } else if (/[？?]\s*$/.test(s) || /[吗呢吧]\s*[。！？?!]?\s*$/.test(s)) {
    rate = 2; pitch = 2; mood = 'question'          // 疑问：略快、略高
  } else if (/[！!]\s*$/.test(s)) {
    rate = 4; pitch = 3; mood = 'exclaim'           // 感叹：快一点、抬一点
  } else if (/…|\.\.\./.test(s)) {
    rate = -3; pitch = -1; mood = 'trail'           // 拖长：放慢、压一点
  } else if (s.length > 0 && s.length <= 6) {
    rate = -2; pitch = 0; mood = 'short'            // 短句：放慢才不显得敷衍
  }

  if (jitter) {
    rate += rng() * 4 - 2
    pitch += rng() * 2 - 1
    // 音量不抖动：忽大忽小比"固定"更像机器故障
  }
  const sign = (n) => (n >= 0 ? '+' : '')
  return {
    rate: `${sign(rate)}${Math.round(rate)}%`,
    pitch: `${sign(pitch)}${Math.round(pitch)}Hz`,
    volume: `${sign(volume)}${Math.round(volume)}%`,
    mood,
  }
}

/**
 * 情绪 → 语音参数表的**加载器**（2026-11-10）。
 *
 * 🔴 真实参数表**不进仓库**：具体每种情绪调多少 rate/pitch/volume，属于调参成果
 * （研究内容），不跟着开源代码发布。仓库里只留一张"能跑起来"的最小中性表。
 *
 * 真实表放 `<repo>/data/emotions.json`，格式：
 * ```json
 * { "撒娇": { "v": 0.6, "a": 0.4, "rate": -4, "pitch": 6, "volume": -5 } }
 * ```
 * `data/emotions.json` 已被 `.gitignore` 排除；没有它时退回最小表，功能不残。
 *
 * 每条含 valence（−1..+1，决定音高方向）与 arousal（0..1，决定能量）；
 * rate/pitch 按强度与符号缩放，**volume 不缩放**。
 */
const MINIMAL_EMOTION_TABLE = {
  平静: { v: 0, a: 0.3, rate: 0, pitch: 0, volume: 0 },
  开心: { v: 0.6, a: 0.6, rate: 2, pitch: 2, volume: 2 },
  委屈: { v: -0.5, a: 0.3, rate: -3, pitch: -2, volume: -6 },
}

function loadEmotionTable() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, '..', 'data', 'emotions.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed
  } catch { /* 文件不存在/损坏：用最小表，不报错 */ }
  return MINIMAL_EMOTION_TABLE
}

export const EMOTION_PROSODY = loadEmotionTable()

/**
 * 情绪 → CosyVoice2 的 instruct 文案（2026-11-13）。
 *
 * CosyVoice2 吃的是**自然语言**，不是参数，所以这里写成一句人话；
 * 同一份参考音频 + 不同指令，就是"同一把声音换四种语气"。
 * 表内情绪之外的一律留空（服务端会走零样本克隆，语气跟参考走）。
 */
export const COSY_INSTRUCT = {
  撒娇: '用撒娇的语气说，尾音拖长一点',
  委屈: '用委屈的语气说，声音小一点',
  困: '用困倦的语气说，含糊一点',
  开心: '用开心的语气说，语调上扬',
  生气: '用有点生气的语气说，语速快一点',
  害羞: '用害羞的语气说，声音小一点',
  期待: '用期待的语气说',
  失落: '用失落的语气说，慢一点',
  心虚: '用心虚的语气说，声音小一点',
  平静: '用平静的语气说',
}

/** 英文/拼音别名，方便模型用哪种写哪种（大小写不敏感）。 */
const EMOTION_ALIASES = {
  happy: '开心', joy: '开心', glad: '开心',
  coax: '撒娇', coquettish: '撒娇', cute: '撒娇',
  shy: '害羞', blush: '害羞',
  eager: '期待', expect: '期待',
  sad: '委屈', aggrieved: '委屈',
  down: '失落', letdown: '失落', lonely: '失落',
  fear: '害怕', afraid: '害怕', scared: '害怕',
  angry: '生气', mad: '生气',
  guilty: '心虚', nervous: '心虚',
  sleepy: '困', tired: '困',
}

const fmtSigned = (value, unit) => `${value >= 0 ? '+' : ''}${Math.round(value)}${unit}`

/**
 * 情绪名 + 强度 → 三个参数。
 *
 * - `intensity` 0..1，缺省 0.6；幅度 = 0.5 + intensity（0.5–1.5 倍）。
 * - **符号修正**：负向 ×1.2、正向 ×0.8 —— 负向更外显，正向更收敛。
 * - `volume` **不缩放**：它只随情绪类型走，不随强度放大。
 *
 * @returns {{rate:string,pitch:string,volume:string,mood:string}|null} 未知情绪返回 null（交给兜底）。
 */
export function emotionToProsody(emotion, intensity = 0.6, table = EMOTION_PROSODY) {
  const raw = String(emotion ?? '').trim()
  if (raw === '') return null
  // `table` 可注入：仓库里的单测用假表验证换算逻辑，不依赖真实调参数值。
  const key = table[raw] ? raw : EMOTION_ALIASES[raw.toLowerCase()]
  const row = key ? table[key] : null
  if (!row) return null

  const n = Number(intensity)
  const level = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6
  const gain = 0.5 + level
  const sign = row.v < 0 ? 1.2 : row.v > 0 ? 0.8 : 1

  return {
    rate: fmtSigned(row.rate * gain * sign, '%'),
    pitch: fmtSigned(row.pitch * gain * sign, 'Hz'),
    volume: fmtSigned(row.volume, '%'),
    mood: key,
  }
}

/**
 * 从回复里剥出情绪标签（抄 `czqwq/astrbot_plugin_tts_llm` 的做法，行 371–378）。
 *
 * 形如 `[emotion=委屈]` / `[emotion=coax][intensity=0.8]`；标签会被删掉，正文照常发。
 * **解析失败不是错误**：没有标签就返回空 emotion，后续走关键词兜底。
 */
export function parseEmotionTags(text) {
  let s = String(text ?? '')
  let emotion = ''
  let intensity = null

  const em = s.match(/\[emotion\s*=\s*([^\]]+)\]/i)
  if (em) {
    emotion = em[1].trim()
    s = s.replace(em[0], '')
  }
  const it = s.match(/\[intensity\s*=\s*([0-9]*\.?[0-9]+)\]/i)
  if (it) {
    intensity = Number(it[1])
    s = s.replace(it[0], '')
  }
  return { text: s.trim(), emotion, intensity }
}

/**
 * 把歌词切成"一句一行"。
 *
 * 先按换行切，再按中英文句读切；丢掉空句；单句超过 40 字硬切一次
 * （Azure 对超长 `<s>` 的韵律处理反而更平，切短了起伏才明显）。
 * 上限 60 句：再长就是拿 TTS 当播放器了，请求体也会很大。
 */
export function splitLyricLines(lyrics, { maxLines = 60, maxCharsPerLine = 40 } = {}) {
  const raw = String(lyrics ?? '')
  const chunks = []
  for (const para of raw.split(/\r?\n/)) {
    for (const piece of para.split(/[，。！？；、,.!?;]+/)) {
      let text = piece.trim()
      if (text === '') continue
      while (text.length > maxCharsPerLine) {
        chunks.push(text.slice(0, maxCharsPerLine))
        text = text.slice(maxCharsPerLine)
      }
      if (text !== '') chunks.push(text)
      if (chunks.length >= maxLines) return chunks.slice(0, maxLines)
    }
  }
  return chunks.slice(0, maxLines)
}

/**
 * 唱腔 SSML。
 *
 * 旋律用 pitch 百分比循环 —— 不是真正的歌，但比平读有明显起伏；
 * `rate="-8%"` 让每句慢一点，不然串起来太赶。句间不加 `<break>`：
 * Azure 的 `<s>` 自带停顿，硬加会拖。
 */
export function buildSongSsml(lyrics, voice, style) {
  const lines = splitLyricLines(lyrics)
  if (lines.length === 0) throw new Error('歌词是空的')
  const melody = ['+0%', '+6%', '+12%', '+6%', '+19%', '+12%']
  const body = lines
    .map((text, index) => {
      const pitch = melody[index % melody.length]
      return `<s><prosody pitch="${pitch}" rate="-8%">${escapeXml(text)}</prosody></s>`
    })
    .join('')
  const styleAttr = style ? ` style="${escapeXml(style)}"` : ''
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${escapeXml(voice)}"${styleAttr}>${body}</voice></speak>`
}

/** Build the JSON body for a GPT-SoVITS api_v2 POST /tts request (pure, testable). */
export function buildLocalTtsRequest(config, text) {
  return {
    text,
    text_lang: config.ttsLocalTextLang || 'zh',
    ref_audio_path: config.ttsLocalRefAudio || '',
    prompt_text: config.ttsLocalPromptText || '',
    prompt_lang: config.ttsLocalPromptLang || 'zh',
    media_type: 'wav',
    streaming_mode: 0,
  }
}

/** Azure SSML 合成的公共部分（语音/唱歌只差 SSML）。 */
async function synthesizeAzure(config, ssml) {
  const region = config.ttsAzureRegion || 'eastasia'
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.ttsApiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'dsh-qq-onebot-bridge',
    },
    body: ssml,
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`Azure TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
  { const audio = Buffer.from(await response.arrayBuffer()); assertAudio(audio, 'mp3', 'Azure TTS'); return { audio, format: 'mp3' } }
}

export async function synthesizeTts(config, text, { voice = '', emotion = '', intensity = null } = {}) {
  /**
   * 先整理成适合朗读的形状（2026-11-08）：去 markdown、换行当句读、补句末、按句截断。
   * 只在「说」这条路上做；唱歌走 `synthesizeSong`，歌词不能被加句号。
   */
  /**
   * 先把情绪标签剥掉再规范化（2026-11-10）：
   * `[emotion=委屈]` 是给桥看的，不能念出来；`normalizeSpeechText` 又会把它当正文保留。
   * 剥完没有标签时 `emotion` 为空 —— 后面自然落到 `pickProsody` 的关键词兜底。
   */
  const tagged = parseEmotionTags(text)
  /**
   * 文本里没有标签时，用调用方传进来的情绪（2026-11-11）：
   * 桥在净化回复时已经把标签剥掉了；语音那条路拿到的是纯正文，
   * 情绪通过 `options.emotion` 单独传，不然语音就丢了情绪。
   */
  const emo = tagged.emotion || String(emotion ?? '').trim()
  const strength = tagged.intensity ?? (Number.isFinite(Number(intensity)) ? Number(intensity) : null)
  const spoken = normalizeSpeechText(tagged.text)
  if (spoken === '') throw new Error('TTS 文本是空的')
  if (config.ttsProvider === 'openai') {
    const base = String(config.ttsBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    assertTtsHost(base, config, 'OpenAI 兼容 TTS')
    /**
     * 语气 → rate/pitch（2026-11-08）。默认自动，`ttsExpressiveness=false` 可关；
     * `ttsRate`/`ttsPitch` 非空时**以手填为准**，方便固定成某一种声线。
     * 这两个字段不是 OpenAI 官方 /audio/speech 的参数，本地 edge-tts 桥认它们；
     * 真正的 OpenAI 端点会忽略未知字段，不会因此报错。
     */
    /**
     * 情绪优先（2026-11-10）：有 `[emotion=…]` 就用表里的方向 + 强度；
     * 没有标签或标签不认识，才退回 `pickProsody` 的关键词/标点判断。
     */
    const auto = config.ttsExpressiveness === false
      ? { rate: '', pitch: '', volume: '' }
      : (emotionToProsody(emo, strength ?? 0.6) || pickProsody(spoken))
    const rate = String(config.ttsRate ?? '').trim() || auto.rate
    const pitch = String(config.ttsPitch ?? '').trim() || auto.pitch
    // 音量跟着情绪走（委屈/困更小、开心更大）：服务端 edge-tts 桥认 volume 字段
    const volume = auto.volume || ''
    const payload = { model: config.ttsModel || 'tts-1', voice: voice || config.ttsVoice || 'alloy', input: spoken }
    if (rate) payload.rate = rate
    if (pitch) payload.pitch = pitch
    if (volume) payload.volume = volume
    const response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ttsApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
    { const audio = Buffer.from(await response.arrayBuffer()); assertAudio(audio, 'mp3', 'OpenAI 兼容 TTS'); return { audio, format: 'mp3' } }
  }
  if (config.ttsProvider === 'qwen') {
    /**
     * Qwen3-TTS Base 本地服务（2026-11-13）。
     *
     * 比 CosyVoice2 干净（zcr 0.11 vs 0.20，参考 0.097），但**没有 instruct**：
     * 语气只能靠参考音频。`ref_text` 必须和参考音频逐字一致，否则发音会乱。
     */
    const base = String(config.ttsQwenUrl || 'http://127.0.0.1:9001').replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180000)
    try {
      const response = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: spoken,
          ref_audio: String(config.ttsQwenRefAudio || ''),
          ref_text: String(config.ttsQwenRefText || ''),
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Qwen3 TTS HTTP ${response.status}`)
      const audio = Buffer.from(await response.arrayBuffer())
      assertAudio(audio, 'wav', 'Qwen3-TTS')
      return { audio, format: 'wav' }
    } finally {
      clearTimeout(timer)
    }
  }
  if (config.ttsProvider === 'cosyvoice') {
    /**
     * CosyVoice2 本地服务（2026-11-13）：参考音频定音色，instruct 定语气。
     *
     * 这是目前唯一能同时做到「音色锁死 + 语气可换」的本地方案：
     * - 音色：同一份 `ttsCosyRefAudio`，每次都用它；
     * - 语气：按本轮情绪翻成一句自然语言指令（见 COSY_INSTRUCT）。
     * 慢：fp16 下单句 16–20 秒，调用方要有"文字先发、语音后到"的准备。
     */
    const base = String(config.ttsCosyUrl || 'http://127.0.0.1:8999').replace(/\/+$/, '')
    // 情绪可能是英文别名（coax/sleepy），先归一到中文键再查指令
    const emoKey = EMOTION_PROSODY[emo] ? emo : (EMOTION_ALIASES[String(emo).toLowerCase()] || emo)
    const instruct = String(config.ttsCosyInstruct || '').trim() || COSY_INSTRUCT[emoKey] || ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120000)
    try {
      const response = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: spoken,
          instruct,
          ref_audio: String(config.ttsCosyRefAudio || ''),
          ref_text: String(config.ttsCosyRefText || ''),
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`CosyVoice HTTP ${response.status}`)
      const audio = Buffer.from(await response.arrayBuffer())
      assertAudio(audio, 'wav', 'CosyVoice2')
      return { audio, format: 'wav' }
    } finally {
      clearTimeout(timer)
    }
  }
  if (config.ttsProvider === 'local') {
    // Local GPT-SoVITS api_v2: POST /tts returns raw wav bytes (or a JSON error).
    const base = String(config.ttsLocalUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    assertTtsHost(base, config, '本地 GPT-SoVITS')
    const response = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLocalTtsRequest(config, spoken)),
      signal: AbortSignal.timeout(120000),
    })
    if (!response.ok) {
      let detail = ''
      try { detail = (await response.json()).message ?? '' } catch { detail = await response.text().catch(() => '') }
      throw new Error(`本地 TTS HTTP ${response.status}: ${String(detail).slice(0, 120)}`)
    }
    { const audio = Buffer.from(await response.arrayBuffer()); assertAudio(audio, 'wav', '本地 GPT-SoVITS'); return { audio, format: 'wav' } }
  }
  // Azure Speech REST (SSML)
  const chosen = voice || config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
  return synthesizeAzure(config, buildAzureSsml(spoken, chosen, config.ttsStyle || ''))
}

/**
 * TTS 出网白名单（V⑥ 修复，2026-11-04）。
 *
 * 判据：loopback 永远放行；其余 host 必须在 `ttsAllowedHosts` 里（支持 `*.example.com` 通配）。
 * 抛错信息里带 host，但不带完整 URL（URL 里可能已经有密钥）。
 */
function assertTtsHost(rawUrl, config, where) {
  let url
  try { url = new URL(rawUrl) } catch { throw new Error(`${where}：ttsBaseUrl 不是合法 URL`) }
  const host = url.hostname.toLowerCase()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')
  if (loopback) return
  const allow = (Array.isArray(config.ttsAllowedHosts) ? config.ttsAllowedHosts : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean)
  const hit = allow.some((rule) => rule === host
    || (rule.startsWith('*.') && host.endsWith(rule.slice(1)))
    || host.endsWith('.' + rule))
  if (!hit) {
    throw new Error(`${where}：拒绝访问 ${host} —— 不在 TTS 出网白名单 ttsAllowedHosts 里`
      + `（当前允许：${allow.join('、') || '（空）'}；loopback 永远允许）`)
  }
}

/** 响应体大小上限（V⑤/K⑤ 的同类防护：一条语音不该超过这个量级）。 */
const TTS_MAX_AUDIO_BYTES = 32 * 1024 * 1024

async function readAudio(response, where) {
  const len = Number(response.headers?.get?.('content-length') ?? 0)
  if (len > TTS_MAX_AUDIO_BYTES) throw new Error(`${where}：响应 ${(len / 1048576).toFixed(1)}MB 超过上限 32MB`)
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > TTS_MAX_AUDIO_BYTES) throw new Error(`${where}：响应 ${(buf.length / 1048576).toFixed(1)}MB 超过上限 32MB`)
  return buf
}

/**
 * 校验返回的字节**确实是音频**（2026-11-04，故障注入测试抓到的洞）。
 *
 * 起因：上游返回 `HTTP 200` + 一段 JSON（比如限流提示、错误对象）时，
 * 原实现会把它当 mp3 直接发给 QQ —— 用户收到一条"坏掉的语音"，
 * 而且因为 HTTP 是 200，日志里一切正常，**根本查不出来**。
 *
 * 判据只看文件头（够用且不依赖第三方解码器）：
 *   mp3  → `ID3` 或 MPEG 帧同步（0xFF 后高 3 位全 1）
 *   wav  → `RIFF`
 *   ogg/opus → `OggS`
 */
export function looksLikeAudio(buffer, format = 'mp3') {
  if (!buffer || buffer.length < 4) return false
  const b = buffer
  if (format === 'wav') return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return true   // OggS
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true                    // ID3
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true                            // MPEG 帧同步
  return false
}

/** 断言音频有效，否则抛错（带上头部十六进制，够定位又不至于把正文全吐出来）。 */
function assertAudio(buffer, format, where) {
  if (looksLikeAudio(buffer, format)) return
  const head = Buffer.from(buffer ?? []).subarray(0, 16).toString('hex').replace(/(..)/g, '$1 ').trim()
  const text = Buffer.from(buffer ?? []).subarray(0, 60).toString('utf8').replace(/\s+/g, ' ')
  throw new Error(`${where} 返回的不是音频（${buffer?.length ?? 0} 字节，头 ${head}，开头文字「${text}」）`
    + ' —— 上游很可能回了错误 JSON 而不是音频')
}

/**
 * 唱一段。
 *
 * 两个后端（2026-11-04 扩）：
 *   · azure  —— SSML 逐句 pitch（真能调音高）
 *   · 本地 openai 兼容服务 —— POST `{base}/audio/sing`，由服务自己逐句合成再拼接
 *     （本机 `qq_chat/tts-server/server.py` 就是这个：edge-tts 逐句 + mp3 帧流拼接）
 *
 * 其它 provider 直接抛错并说清原因 —— 不要悄悄退化成"平读"，
 * 那样用户会以为是音色不对，而不是"这个后端压根不支持唱"。
 */
export async function synthesizeSong(config, lyrics, { voice = '' } = {}) {
  if (config.ttsProvider === 'azure') {
    if (!config.ttsApiKey) throw new Error('没配 ttsApiKey，唱不了')
    const chosen = voice || config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
    return synthesizeAzure(config, buildSongSsml(lyrics, chosen, config.ttsStyle || ''))
  }
  // 本地 OpenAI 兼容服务：它有 /audio/sing（逐句不同 pitch + 拼接），交给它做
  const root = localRoot(config)
  if (root !== '') assertTtsHost(root, config, '本地服务唱歌')
  if (root === '') throw new Error(`当前 ttsProvider=${config.ttsProvider || '（空）'} 不支持唱：没配 ttsBaseUrl（指向本地语音服务），Azure 之外的后端要用本地服务唱`)
  const response = await fetch(`${root}/v1/audio/sing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lyrics: String(lyrics ?? ''), voice }),
    signal: AbortSignal.timeout(180000),   // 逐句合成，比单句慢得多
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`本地服务唱失败 HTTP ${response.status}: ${String(detail).slice(0, 160)}`)
  }
  const sung = Buffer.from(await response.arrayBuffer())
  assertAudio(sung, 'mp3', '本地服务唱歌')
  return { audio: sung, format: 'mp3' }
}

/**
 * 本地语音服务的根地址：`http://127.0.0.1:8977/v1` → `http://127.0.0.1:8977`。
 * 那个服务的路由是 `/v1/audio/*` 与 `/voice`，两个前缀不统一，所以这里拆开。
 */
function localRoot(config) {
  return String(config.ttsBaseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/** 列出本地服务提供的音色（`GET /v1/audio/voices`）。返回 `{ current, data[] }`。 */
export async function fetchLocalVoices(config) {
  const root = localRoot(config)
  if (root !== '') assertTtsHost(root, config, '读音色列表')
  if (root === '') throw new Error('没配 ttsBaseUrl，读不到本地服务的音色列表')
  const response = await fetch(`${root}/v1/audio/voices`, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`读音色列表 HTTP ${response.status}`)
  const data = await response.json()
  return { current: String(data?.current ?? ''), data: Array.isArray(data?.data) ? data.data : [] }
}

/** 切换本地服务的音色（`POST /voice`）。它会把选择记进 voice.txt，重启也保留。 */
export async function switchLocalVoice(config, name) {
  const root = localRoot(config)
  if (root !== '') assertTtsHost(root, config, '切音色')
  if (root === '') throw new Error('没配 ttsBaseUrl，切不了音色')
  const response = await fetch(`${root}/voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: String(name ?? '') }),
    signal: AbortSignal.timeout(8000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok !== true) {
    const available = Array.isArray(data?.available) ? data.available.join('、') : ''
    throw new Error(`切换失败：${data?.reason ?? `HTTP ${response.status}`}${available ? `（可用：${available}）` : ''}`)
  }
  return { current: String(data?.current ?? name), voiceId: String(data?.voiceId ?? '') }
}
