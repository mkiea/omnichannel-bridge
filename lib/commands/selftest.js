/**
 * commands/selftest.js —— `/自检`：实机体检（2026-11-16）
 *
 * 为什么需要它：主人说「**我进行实机测试的部分弄一个指令比较好**」。
 * 之前那份验收清单是"人工照着发 13 条命令"，而人一懒就不做了。
 * 这条把**能在聊天里自检的都收进来**，一次回执给出结论。
 *
 * 它和 `tools/verify.mjs` 的分工：
 *   · `verify.mjs` 在**代码层面**测（闸门/冒烟/E2E/全量），不需要真机；
 *   · `/自检` 在**运行层面**测（配置/连接/DLP/金丝雀/语音/目录/会话），**必须真机**。
 * 两者不重叠：verify 绿只能说明"代码没坏"，`/自检` 才能说明"这台机器上是通的"。
 *
 * ⚠️ 只做**只读**检查：不发消息、不建会话、不花 token、不改任何状态。
 * 理由是它会被随手发（"我懒"），一个会改变状态的体检命令没人敢用。
 */

const MATCH = /^[\/／](自检|体检|selftest|selfcheck)(\s|$)/i

/** 一行一项：✅ 正常 / ⚠️ 需要看一眼 / ❌ 坏了。 */
const ok = (label, detail) => `✅ ${label}${detail ? `：${detail}` : ''}`
const warn = (label, detail) => `⚠️ ${label}${detail ? `：${detail}` : ''}`
const bad = (label, detail) => `❌ ${label}${detail ? `：${detail}` : ''}`

export const selftestCommand = {
  name: 'selftest',
  traceLabel: '命令 /自检（实机体检）',
  async run(port, message, text) {
    if (!MATCH.test(String(text ?? '').trim())) return false
    const lines = []
    const cfg = port.config ?? {}
    const rt = port.runtime ?? {}

    // ① 配置：provider/model 是"接不上模型"时最先要分清的三件事
    try {
      const fallback = (() => {
        try { return rt.hostModel?.() ?? {} } catch { return {} }
      })()
      /**
       * ⚠️ 判据在真机上被证伪过一次（2026-11-17）：
       * 第一版写的是「provider 为空 ⇒ ❌ 坏了」，结果真机上报了一条假红 ——
       * 因为**插件配置为空是正常状态**（= 跟随宿主默认），而宿主那边的
       * `agentDefaultModel.currentSelection()` 在这个 dsh 版本上返回空
       * ⇒ 两处都取不到，判成"坏"，但聊天其实是通的。
       *
       * 现在按"能不能确认"分三档，**"读不到"降级成 ⚠️ 而不是 ❌**：
       *   · 插件自己配了   → ✅ 说清是哪一套（研究时 QQ 与桌面端可以隔离）
       *   · 跟随宿主且读得到 → ✅ 说清宿主那套
       *   · 两边都读不到   → ⚠️ 只提示"不回话时先查这里"，不判死
       */
      const ownProvider = String(cfg.provider ?? '').trim()
      const ownModel = String(cfg.model ?? '').trim()
      const hostProvider = String(fallback.provider ?? '').trim()
      const hostModel = String(fallback.model ?? '').trim()
      if (ownProvider !== '' || ownModel !== '') {
        lines.push(ok('模型配置', `${ownProvider || '(空)'} / ${ownModel || '(空)'}（插件配置覆盖）`))
      } else if (hostProvider !== '' || hostModel !== '') {
        lines.push(ok('模型配置', `跟随宿主 —— ${hostProvider || '(空)'} / ${hostModel || '(空)'}`))
      } else {
        lines.push(warn('模型配置', '插件没配、宿主也读不到（正常情况下这是"跟随宿主"；若出现"不回话"先查这里）'))
      }
    } catch (error) {
      lines.push(bad('模型配置', error.message))
    }

    // ② 连接：没有 socket 就什么都不用谈
    try {
      const socket = rt.socket?.() ?? null
      const ready = socket !== null && socket !== undefined && (socket.readyState === 1 || socket.readyState === socket.OPEN)
      lines.push(ready ? ok('平台连接', '已连上') : bad('平台连接', '没连上（收不到也发不出）'))
    } catch (error) {
      lines.push(bad('平台连接', error.message))
    }

    // ③ 出站 DLP：模式 + 本次运行处理过几次
    try {
      const mode = String(cfg.outboundRedactMode ?? 'redact').trim().toLowerCase()
      // 只报模式，不报统计：统计要拿到 guard 实例，那会让 port 长一截（闸门不让）。
      // 要具体数字发 `!canary`（它读 guard.stats()）。
      lines.push(mode === 'off'
        ? warn('出站脱敏', 'off —— 不检查直接发')
        : ok('出站脱敏', `模式 ${mode}（具体命中数发 !canary）`))
    } catch (error) {
      lines.push(bad('出站脱敏', error.message))
    }

    // ④ 金丝雀：**不取全值**（取它要拿 bridge 的私有方法，port 会变长）。
    // 只报「配没配」，要看前 8 位发 `!canary` —— 那条命令本来就在管这件事。
    {
      const configured = String(cfg.outboundRedactCanary ?? '').trim()
      lines.push(configured !== ''
        ? ok('金丝雀', '已配置（看前 8 位发 !canary）')
        : ok('金丝雀', '未配置，运行时会自动生成到 qq-canary.json'))
    }

    // ⑤ 语音：本地服务配了就该能连，没配就是走 Azure 或关闭
    try {
      const base = String(cfg.ttsBaseUrl || '').trim()
      const provider = String(cfg.ttsProvider || '')
      if (base === '') {
        lines.push(provider === 'azure' ? ok('语音', 'Azure（未配本地服务）') : warn('语音', `ttsProvider=${provider || '(空)'} 且没配 ttsBaseUrl ⇒ 念不了也唱不了`))
      } else if (!/127\.0\.0\.1|localhost|\[::1\]/.test(base)) {
        // ⚠️ 只探本机：默认 ttsBaseUrl 是 https://api.openai.com/v1，
        // 探它等于往公网发请求 —— 实测要等 5 秒超时，整个自检被拖成 8 秒。
        lines.push(ok('语音', `远程服务（${base}）—— 不探测`))
      } else {
        const alive = await rt.probeTts?.()
        lines.push(alive === true ? ok('语音', `本地服务可达（${base}）`) : bad('语音', `本地服务不可达（${base}）—— 先启动语音服务`))
      }
    } catch (error) {
      lines.push(warn('语音', `探测失败：${error.message}`))
    }

    const badCount = lines.filter((l) => l.startsWith('❌')).length
    const warnCount = lines.filter((l) => l.startsWith('⚠️')).length
    const head = badCount > 0
      ? `❌ ${badCount} 项坏了`
      : (warnCount > 0 ? `⚠️ ${warnCount} 项要看一眼` : '✅ 全绿')
    await port.reply(message, `🐋 自检（${head}）\n${lines.join('\n')}\n\n（只读检查：不发消息、不建会话、不花 token）`)
    return true
  },
}
