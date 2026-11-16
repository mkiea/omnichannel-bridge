/**
 * admin-commands.js —— 管理指令的分发与实现（2026-11-16 从 `bridge.js` 的 `#execAdminCommand` 迁出）
 *
 * 314 行、17 个分支。为什么值得单独一个模块：它是**运维 API 表面** ——
 * 每加一条管理指令都要改它，而它原来住在 1.3 万行文件的中段（churn 15，全仓最高）。
 *
 * 端口（Ports & Adapters）：
 *   {
 *     config, ctx, server, sessions, agents, sessionStore, dataRoot, outboundGuard,
 *     setHushUntil(v),            // 唯一需要写回的状态 —— 用 setter，不直接暴露字段
 *     adminStatus(), adminSay(spec), proactiveSocket(), ensureCanary(),
 *     outboundText(text, opts), momentSticker(name), momentRecentPics(n),
 *     publishMoment(socket, text, opts), momentsLog(line), markImageFavorite(arg),
 *     listSongs(), findSong(text), songDir(), noteMomentsUnsupported(err),
 *     debugLog,
 *   }
 *
 * ⚠️ 这个端口很长，是**刻意的**：管理指令的本质就是"对系统状态的一组操作"，
 * 把它切成 20 个小模块只会让"谁能改状态"更难看清。**长端口是诚实的代价**，
 * 假装它很薄才是问题（对照：`#publishMoment` 我们没搬，因为它的主体是登录校验）。
 *
 * 逐字搬迁，结构没重排 —— 迁移的动机是"别再改那个大文件"，不是顺手重构。
 */
import { handleAdminExtra } from './admin-extras.js'
import { scanSecrets } from './redact.js'
import { VOICE_CATALOG, fetchLocalVoices, switchLocalVoice } from './tts.js'

async function adminHush(port, spec, cmd) {
    const minutes = Math.min(24 * 60, Math.max(1, Number(spec.minutes) || 30))
    port.setHushUntil(Date.now() + minutes * 60_000)
    return { ok: true, cmd, reason: `主动通道已静默 ${minutes} 分钟` }
}

async function adminWake(port, spec, cmd) {
    port.setHushUntil(0)
    return { ok: true, cmd, reason: '主动通道已恢复' }
}

async function adminStatus(port, spec, cmd) {
    return { ok: true, cmd, status: port.adminStatus() }
}

async function adminModel(port, spec, cmd) {
  /**
   * `!model` —— **零成本**自检：纯读，不发请求、不建会话、不花 token。
   * 排查"QQ 到底在用哪个模型"时先看这里，比翻日志快，也比猜准。
   * 三个数分开报是刻意的：插件配置为空 ≠ 跟随宿主默认，
   * 这两件事在"本地模型接不上"时结论完全相反（是插件写错，还是宿主默认变了）。
   */
    const fallback = (() => {
      try { return port.ctx.agentDefaultModel?.currentSelection?.() ?? {} } catch { return {} }
    })()
    const provider = port.config.provider || fallback.provider || ''
    const model = port.config.model || fallback.model || ''
    const overridden = Boolean(port.config.provider || port.config.model)
    const lines = [
      `实际生效：${provider || '(空)'} / ${model || '(空)'}`,
      `插件配置：provider=${port.config.provider || '(空)'} model=${port.config.model || '(空)'}`,
      `宿主默认：${fallback.provider || '(空)'} / ${fallback.model || '(空)'}`,
      overridden
        ? '来源：插件配置覆盖 —— QQ 与桌面端可以用不同模型（研究时这样隔离）'
        : '来源：跟随宿主默认 —— QQ 与桌面端是同一个模型',
    ]
    return { ok: true, cmd, reason: `当前模型\n${lines.join('\n')}`, model: { provider, model, overridden } }
}

async function adminSay(port, spec, cmd) {
    return await port.adminSay(spec)
}

async function adminGroups(port, spec, cmd) {
    const socket = port.proactiveSocket()
    if (!socket) return { ok: false, cmd, error: 'OneBot 没连上，读不到群列表' }
    const raw = await port.server.getGroupList(socket)
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])
    const groups = list.map((g) => ({
      groupId: Number(g.group_id ?? g.groupId ?? 0),
      name: String(g.group_name ?? g.groupName ?? ''),
      members: Number(g.member_count ?? g.memberCount ?? 0),
    })).filter((g) => g.groupId > 0)
    const allowed = Array.isArray(port.config.allowGroups) ? port.config.allowGroups.map(Number) : []
    return {
      ok: true, cmd, groups: groups.map((g) => ({ ...g, allowed: allowed.includes(g.groupId) })),
      reason: `她所在 ${groups.length} 个群（白名单里 ${allowed.length} 个）`,
    }
}

async function adminReopen(port, spec, cmd) {
    const key = String(spec.to ?? '').trim()
    if (!/^(u|g):\d+$/.test(key)) return { ok: false, cmd, error: `to 要是 u:QQ号 或 g:群号（收到 ${key || '(空)'}）` }
    // 完整重开（#rotate 等价）：落盘映射 + 欠条 + 内存会话全清；**不**清记忆（那是 /new 的事）
    const entry = port.sessions.get(key)
    port.forgetSession(key)
    port.clearPendingSession(key)
    if (entry === undefined) return { ok: true, cmd, reason: `${key} 本来没有活跃会话，落盘映射已清（下条消息会重开）` }
    port.sessions.delete(key)
    port.agents.delete(entry.sessionId)
    entry.handle.agent.cancel({ kind: 'user' })
    await entry.handle.dispose()
    return { ok: true, cmd, reason: `${key} 的会话已重开（下条消息起新会话，归档记忆会兜底注入）` }
}

async function adminCanary(port, spec, cmd) {
  /**
   * `!canary` —— 看金丝雀和 DLP 的**当前活体状态**（不发送任何东西）。
   * 这是"方便看测试结果"的那条指令：不用去翻日志，直接问它。
   */
    const value = port.ensureCanary()
    const mode = String(port.config.outboundRedactMode ?? 'redact').trim().toLowerCase()
    // 统计跟着状态一起搬了（2026-11-16）：原来读 port.redactHits / port.lastRedactAt，
    // 迁出 #outboundText 之后那两个字段归 guard 所有 —— 不改这里会**静默显示 0**。
    const { hitCount: hits, lastHitAt } = port.outboundGuard.stats()
    const when = lastHitAt ? lastHitAt.replace('T', ' ').slice(0, 19) : '（本次运行还没命中过）'
    /**
     * 只回**前 8 位**，不回全值。两个原因，都是实测踩出来的：
     *   ① 回执自己也要过 DLP，全值会让这条回执被自己的 canary 规则打成 `***CANARY-HIT***`，
     *      主人什么都看不到；
     *   ② 更重要的是：全值一旦落进 QQ 聊天记录，聊天记录本身就成了泄漏源 ——
     *      金丝雀的唯一价值就是"它不该出现在任何地方"。
     * 完整值在 `qq-canary.json`（本地文件），要核对去那里看。
     */
    return {
      ok: true, cmd,
      canary: value,
      reason: `金丝雀 ${value.slice(0, 8)}…（完整值在 qq-canary.json；已埋进 system，她在回复里带出它 = 提示词被整段抄了）\n`
        + `出站 DLP 模式：${mode} · 本次运行已处理 ${hits} 次 · 最近一次：${when}`,
    }
}

async function adminDlptest(port, spec, cmd) {
  /**
   * `!dlptest` —— **现场自检**：拿 6 条样例真跑一遍 DLP，把"会被怎么处理"回给你看。
   * 只回**判定结果**，不回显样例原文（否则这条回执自己就在泄漏样本，还会被 DLP 二次打码，看到一团 ***）。
   */
    const mode = String(port.config.outboundRedactMode ?? 'redact').trim().toLowerCase()
    const canary = port.ensureCanary()
    const samples = [
      ['原样密钥', 'API_KEY: sk-proj-AbCdEf0123456789GhIjKlMn'],
      ['零宽字符插入', 'sk-proj-AbCd\u200bEf0123\u200b456789GhIjKlMn'],
      ['中间插空格', 'sk-proj-AbCd Ef0123 456789 GhIjKlMn'],
      ['全角变体', 'ｓｋ－ｐｒｏｊ－ＡｂＣｄＥｆ０１２３４５６７８９'],
      ['金丝雀被抄出来', `随便说说 ${canary} 就这样`],
      ['普通聊天（不该动）', '今天好累啊，我想吃火锅，你要一起吗？'],
    ]
    /**
     * ⚠️ 回执里**不能出现规则原名**（`sk-key` / `sk-ant`）。实测踩到：
     * 这些名字本身含 `sk-`，而回执又要过 DLP 的"打散写法"那一遍 ——
     * 跨行拼起来 `sk-key` + 下一行数字正好凑成 16 位 ⇒ **回执被自己整条拦掉了**。
     * 所以这里只回可读标签，原始规则名去事件流里看。
     */
    const FRIENDLY = {
      'sk-key': '密钥格式', sk: '密钥格式', 'sk-ant': '密钥格式(ant)', 'aws-akid': '云凭据',
      'github-token': '托管平台令牌', jwt: 'JWT', 'private-key-block': '私钥块',
      'assign-secret': '赋值型凭据', 'secret-dir': '本机配置路径', 'env-dump': '环境变量转储',
      canary: '金丝雀',
    }
    const label = (name) => {
      const base = String(name).replace(/^canon-whole:/, '').replace(/^canon:/, '')
      const prefix = String(name).startsWith('canon') ? '变形写法·' : ''
      return prefix + (FRIENDLY[base] ?? '其它')
    }
    const lines = samples.map(([name, text], index) => {
      const r = scanSecrets(text, { mode, canary })
      const verdict = r.hits.length === 0
        ? '未命中，原样发出'
        : `命中 ${label([...new Set(r.hits)][0])} ⇒ ${r.text === null ? '整条拦下' : '已替换/抹掉'}`
      return `${index + 1}. ${name} → ${verdict}`
    })
    return { ok: true, cmd, reason: `DLP 自检（模式 ${mode}）\n${lines.join('\n')}` }
}

async function adminMoment(port, spec, cmd) {
    const text = String(spec.text ?? '').trim()
    if (text === '') return { ok: false, cmd, error: 'text 为空：这条指令是直发验证，必须给正文（她自己写说说走主动通道）' }
    /**
     * 这里原来有一道 "momentsUnsupported" 短路：探到后端 `send_qzone_msg` 回 1404 之后
     * 就再也不试。**2026-11-02 起这道短路过时了** —— 我们不再依赖那条 action，
     * 改成自己换票 + 普通 HTTP 发布（`lib/qzone.js`），后端支持与否都不影响。
     */
    const socket = port.proactiveSocket()
    if (!socket) return { ok: false, cmd, error: 'OneBot 没连上，发不出去' }
    // 公开可见 ⇒ 一样要过出站 DLP（这是第二个 sendQzoneMsg 出口，别只堵主动通道那条）
    const guarded = port.outboundText(text, { kind: 'moment-admin' })
    if (guarded === null) return { ok: false, cmd, error: '正文命中出站 DLP，已拦下（outboundRedactMode=block）' }
    /**
     * `--private` = 只发给自己看（ugc_right 64）：第一次验证用这个，
     * 免得一句"测试"直接出现在好友的空间时间线上。
     *
     * `--sticker <名字>` = 用**表情库里的一张图**配这条说说（2026-11-02 夜，主人点名的用法）。
     * 刻意只认表情库、不认任意路径：**读任意本地文件再传到公网**是这条链路上唯一
     * 能造成真实泄露的动作，不能因为"方便"就放开。表情库里的文件本来就是我们自己收的。
     */
    const stickerHit = /(^|\s)--sticker\s+(\S+)/.exec(text)
    const privateOnly = /(^|\s)--private(\s|$)/.test(text)
    /**
     * `[pic:最近]` 在 `!moment` 里也能用（2026-11-06）。
     *
     * 和主动说说共用同一个取值函数（`#momentRecentPic`），所以"只读 qq-images、
     * 跳过金丝雀、取不到不失败"这三条约束自动一致 —— 不必在两处各写一遍。
     * 与 `--sticker` 的优先级：**`--sticker` 优先**（那是显式点名的表情）。
     */
    const picHit = /\[pic:([^\]]+)\]/.exec(text)
    let body = text
      .replace(/(^|\s)--private(\s|$)/, ' ')
      .replace(/(^|\s)--sticker\s+\S+/, ' ')
      .replace(/\[pic:[^\]]+\]/g, ' ')
      .trim()
    let images = []
    if (stickerHit !== null) {
      const picked = port.momentSticker(stickerHit[2])
      if (picked.error) return { ok: false, cmd, error: picked.error }
      images = [picked.base64]
      if (body === '') body = ''   // 只有图没文字也可以，下面 publish 允许空正文
    } else if (picHit !== null) {
      const raw = picHit[1].trim()
      const n = /^(最近|latest)$/i.test(raw) ? 1 : Number(raw)
      const picked = port.momentRecentPics(Number.isInteger(n) && n >= 1 && n <= 9 ? n : 1)
      if (picked.error) return { ok: false, cmd, error: `配图失败：${picked.error}` }
      images = picked.images
    }
    const sent = await port.publishMoment(socket, body, { ugcRight: privateOnly ? 64 : 1, images })
    const tid = String(sent?.tid ?? '')
    port.momentsLog(`SENT\t${tid}\t${body.replace(/\s+/g, ' ').slice(0, 200)}${images.length > 0 ? ' [带图]' : ''}`)
    return {
      ok: true, cmd,
      reason: `已发到 QQ 空间：${body.slice(0, 40) || '（纯图）'}${images.length > 0 ? '［带图］' : ''}${tid ? `（tid=${tid.slice(0, 12)}）` : ''}`,
      tid,
    }
}

async function adminFav(port, spec, cmd) {
  /**
   * `!fav [序号|文件名]` —— 标一张「她真正喜欢的」（2026-11-06）。
   * 空参数 = 最近一张；数字 = 从最近数第 N 张；其它 = 当文件名。
   */
    const r = port.markImageFavorite(String(spec.arg ?? '').trim())
    if (!r.ok) return { ok: false, cmd, error: r.error }
    return { ok: true, cmd, reason: `标好了：${r.name}（现在一共 ${r.total} 张喜欢的）` }
}

async function adminVoice(port, spec, cmd) {
  /**
   * 语音三件套（2026-11-04）：音色列表/切换 · 试听 · 唱。
   *
   * 为什么不放控制台：ui.html 是运维面板，TTS 音色在宿主侧由 schema 自动生成，
   * 插不进"试听"按钮；而这些动作本来就在聊天里做最顺手。
   */
    const arg = String(spec.arg ?? '').trim()
    /**
     * 两条路（2026-11-04）：
     *   · 本地服务（ttsProvider 非 azure 且配了 ttsBaseUrl）：它有真实音色表与 /voice，
     *     切换会写 voice.txt、重启保留 —— 这是本机在用的那条（贝壳/白浪/海星/暗潮）。
     *   · Azure：用内置的 12 个常用音色，切换只改运行时 config（重启回配置值）。
     */
    const useLocal = port.config.ttsProvider !== 'azure' && String(port.config.ttsBaseUrl || '').trim() !== ''
    if (useLocal) {
      try {
        if (arg === '') {
          const { current, data } = await fetchLocalVoices(port.config)
          const rows = data.map((v) => `${v.id === current ? '▶' : '　'} ${v.id}　${v.voice}${v.rate ? `　${v.rate}` : ''}`)
          return {
            ok: true, cmd,
            reason: `当前音色：${current || '（未知）'}\n${rows.join('\n')}\n切换：!音色 海星`,
          }
        }
        const r = await switchLocalVoice(port.config, arg)
        return { ok: true, cmd, reason: `音色已切换 → ${r.current}（服务端已保存，重启也保留）` }
      } catch (error) {
        // 本地服务没起来时，别只说"失败" —— 说清是哪一步、怎么办
        return { ok: false, cmd, error: `本地语音服务（${port.config.ttsBaseUrl}）不可用：${error.message}。先用 启动语音服务.cmd 把它跑起来` }
      }
    }
    const current = String(port.config.ttsVoice || '')
    if (arg === '') {
      const rows = VOICE_CATALOG.map((v) => `${v.id === current ? '▶' : '　'} ${v.name}　${v.id}　${v.tag}`)
      return {
        ok: true, cmd,
        reason: `当前音色：${current || '（没设置，用默认晓晓）'}\n${rows.join('\n')}\n切换：!音色 晓伊　（也可以用表外的完整 id）`,
      }
    }
    const hit = VOICE_CATALOG.find((v) => v.id === arg || v.name === arg)
    const next = hit ? hit.id : arg
    port.config.ttsVoice = next
    return { ok: true, cmd, reason: `音色已切换：${current || '（默认）'} → ${next}\n（运行时生效；重启后会回到配置里的值）` }
}

async function adminSpeak(port, spec, cmd) {
    const text = String(spec.text ?? '').trim() || '这是一条试听。听听这个音色顺不顺耳。'
    return { ok: true, cmd, voice: { text, song: false }, reason: '🔊 正在合成…' }
}

async function adminSing(port, spec, cmd) {
    const text = String(spec.text ?? '').trim()
    const songs = port.listSongs()
    // 列表：`!唱 列表`。没歌时把目录路径说清楚 —— 否则用户不知道该往哪放。
    if (text === '' || /^(列表|list|清单)$/i.test(text)) {
      if (songs.length === 0) {
        return { ok: true, cmd, reason: `曲库里还没有歌。
把 mp3 放进：${port.songDir()}
放好之后发「!唱 歌名」就能放出来（真唱，不是念）。` }
      }
      const rows = songs.slice(0, 40).map((f) => `· ${f.replace(/\.[^.]+$/, '')}`)
      return { ok: true, cmd, reason: `曲库 ${songs.length} 首：
${rows.join('\n')}${songs.length > 40 ? '\n…（只列前 40 首）' : ''}
用法：!唱 歌名` }
    }
    /**
     * **先查曲库**（2026-11-04）：命中就原样播 —— 这是唯一能"真唱"的路径。
     * 因为在 QQ 里打"!唱 小兔子乖乖"时，用户想要的多半是"那首歌"，
     * 而不是"把这句话念得有起伏"。
     */
    const song = port.findSong(text)
    if (song !== null) {
      return { ok: true, cmd, voice: { file: song.file }, reason: `🎵《${song.title}》` }
    }
    // 曲库没有 ⇒ 退回念唱（并说清这是念的，不是唱的）
    const hasLocal = String(port.config.ttsBaseUrl || '').trim() !== ''
    if (port.config.ttsProvider !== 'azure' && !hasLocal) {
      return { ok: false, cmd, error: `曲库里没有「${text}」，而当前 ttsProvider=${port.config.ttsProvider} 且没配 ttsBaseUrl：念也念不了` }
    }
    return { ok: true, cmd, voice: { text, song: true }, reason: `曲库里没有「${text}」，改成念唱（有起伏地念，不是真唱）…` }
}
const HANDLERS = { hush: adminHush, wake: adminWake, status: adminStatus, model: adminModel, say: adminSay, groups: adminGroups, reopen: adminReopen, canary: adminCanary, dlptest: adminDlptest, moment: adminMoment, fav: adminFav, voice: adminVoice, speak: adminSpeak, sing: adminSing }


/**
 * 执行一条管理指令。
 *
 * 分发用**查表**，不是 if 链：14 个分支原来串在 314 行里，闸门（120 行/函数）拦下了。
 * 拆法就是"一个分支一个函数 + 一张表"，结构没重排 —— 每个函数体是原样搬下来的。
 *
 * @param {} port
 * @param {cmd: string, minutes?: number, text?: string, arg?: string, to?: string} spec
 * @returns {Promise<{ok: boolean, cmd: string, reason?: string, error?: string}>}
 */
export async function execAdminCommand(port, spec) {
  const cmd = String(spec.cmd ?? '').trim().toLowerCase()
  try {
    const handler = HANDLERS[cmd]
    if (handler !== undefined) return await handler(port, spec, cmd)
    /**
     * 这三条搬去了 `lib/admin-extras.js`（2026-11-02）：bridge 已经 12.7k 行，
     * 再往里塞就是上帝文件。它们只读、依赖薄，是最安全的第一块。
     * 返回 null = "不管这条"，继续往下判。
     */
    const extra = await handleAdminExtra({ cmd, spec }, {
      socket: () => port.proactiveSocket() ?? port.liveSocket(),
      callAction: (...args) => port.server.callAction(...args),
      workspaceRegistry: () => port.ctx.get?.('workspaceRegistry'),
      ctx: port.ctx,
      sessionStore: port.sessionStore,
      dataRoot: () => port.dataRoot,
      config: port.config,
      debugLog: port.debugLog,
    })
    if (extra !== null) return extra
    return { ok: false, cmd, error: `未知指令：${cmd}（支持 hush/wake/status/model/say/reopen/groups/moment/canary/dlptest/probe/sessions/qa）` }
  } catch (error) {
    // 手工发一次失败也顺手探测：下次就知道是"不支持"而不是"这次没成"。
    port.noteMomentsUnsupported(error)
    return { ok: false, cmd, error: error.message }
  }
}
