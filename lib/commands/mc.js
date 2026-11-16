/**
 * commands/mc.js —— `/mc` 服务器状态（2026-11-16，第一个走 registry 的命令）
 *
 * 为什么先挑它当样板：它的依赖最少（`mcping.js` 三个纯函数 + `config.mcStatusTimeoutMs`
 * + `reply`），匹配条件是一个精确前缀，与其它命令没有交集 —— 迁它**不会改变优先级**。
 *
 * 它是"加一个命令要动哪里"的第一个实测样本：迁完之后，`bridge.js` 里
 * 这一处从 39 行变成一个 if，实现全在这一个文件里。
 */
import { formatMcStatus, parseMcAddress, pingMcServer } from '../mcping.js'

/** `/mc`、`/mcstatus`、`/mc状态`、`/服务器状态` 都认（与原实现逐字一致）。 */
const MATCH = /^[\/／]?(mc|mcstatus|mc状态|服务器状态)(\s|$)/i

export const mcCommand = {
  name: 'mc',
  // trace 文案保持原样：迁移不改日志，否则看日志的人会以为行为变了
  traceLabel: '本地功能：MC 服务器状态',
  enabled: (config) => config.mcStatusEnabled !== false,
  async run(port, message, text) {
    const t = String(text ?? '').trim()
    if (!MATCH.test(t)) return false
    const address = parseMcAddress(t)
    if (!address) {
      await port.reply(message, '用法：/mc mc.example.com:25565（可省略端口，默认 25565）')
      return true
    }
    try {
      const result = await pingMcServer(address.host, address.port, Math.max(1000, Number(port.config.mcStatusTimeoutMs) || 5000))
      await port.reply(message, formatMcStatus(result, { address: `${address.host}:${address.port}` }))
    } catch (error) {
      await port.reply(message, `⚠️ 查询失败：${error.message.slice(0, 80)}`)
    }
    return true
  },
}
