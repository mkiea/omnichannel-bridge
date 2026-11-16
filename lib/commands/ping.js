/**
 * commands/ping.js —— 示例命令：`/ping`（2026-11-16）
 *
 * 它不是"功能需求"，是**扩展点的验收样本**：证明加一个命令确实不用改 `bridge.js`。
 * 如果哪天 bridge 又需要为它加分支，说明扩展点退化了 —— 这条可以从 `extra.js` 摘掉。
 */
export const pingCommand = {
  name: 'ping',
  traceLabel: '命令 /ping',
  async run(port, message, text) {
    const t = String(text ?? '').trim()
    if (!/^[\/／]ping(?:\s|$)/i.test(t)) return false
    await port.reply(message, 'pong')
    return true
  },
}
