/**
 * commands/fun.js —— 零成本互动包：运势/抽签/塔罗 + 骰子/随机抽人（2026-11-16）
 *
 * 这两个命令是"加功能要改哪里"的最小样本：每个只依赖 `reply` 和一个开关
 * （`fun.fortune` / `fun.dice`），实现全是 `fortune.js` / `dice.js` 里的纯函数。
 * 它们的 `if` 链位置**保持原样**（在 points 之前、撤回之后），所以行为零变化。
 *
 * 开关判断放在 `run` 开头（返回 false = 没命中），不单设 `enabled`：
 * 这两个开关来自 `this.fun`（构造时派生的对象），不是配置项本身 ——
 * 让它走 `run` 就少一层签名约定。
 */
import {
  dailyFortune, drawLot, drawTarot, formatFortune, formatLot, formatTarot, parseFortuneIntent,
} from '../fortune.js'
import {
  formatPick, formatRoll, parseDice, parsePickCommand, pickRandom, rollDice,
} from '../dice.js'

export const fortuneCommand = {
  name: 'fortune',
  traceLabel: '本地功能：运势/抽签/塔罗',
  async run(port, message, text) {
    if (port.fun?.fortune !== true) return false
    const intent = parseFortuneIntent(text)
    if (!intent) return false
    const name = message.senderName || ''
    if (intent === 'lot') {
      await port.reply(message, formatLot(drawLot(message.userId)))
      return true
    }
    if (intent === 'tarot') {
      await port.reply(message, formatTarot(drawTarot(message.userId, text)))
      return true
    }
    await port.reply(message, formatFortune(dailyFortune(message.userId, name)))
    return true
  },
}

export const diceCommand = {
  name: 'dice',
  traceLabel: '本地功能：骰子/随机抽人',
  async run(port, message, text) {
    if (port.fun?.dice !== true) return false
    const spec = parseDice(text)
    if (spec) {
      await port.reply(message, formatRoll(rollDice(spec)))
      return true
    }
    const pick = parsePickCommand(text)
    if (pick) {
      await port.reply(message, formatPick(pickRandom(pick.items, pick.count), pick.items))
      return true
    }
    return false
  },
}
