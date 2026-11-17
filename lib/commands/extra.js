/**
 * commands/extra.js —— **新命令登记处**（2026-11-16）
 *
 * 加一个命令只需要两步，**都不用改 `bridge.js`**：
 *   1. 新建 `lib/commands/<名字>.js`，导出 `{ name, traceLabel, enabled?, run }`；
 *   2. 在下面这个数组里加一项。
 *
 * 为什么单独一个文件而不是直接写在 bridge 的 `createCommandRegistry([...])` 里：
 * 那行在 1.4 万行的文件里，改它仍然要打开、定位、跑闸门。这里是 30 行的登记表，
 * 改动面和"改一个配置项"差不多。
 *
 * ⚠️ **顺序 = 数组顺序 = 分发优先级**。这里登记的命令排在 `#onQqMessageInner`
 * 的 if 链**末尾**（老命令都在前面），所以：
 *   · 精确前缀（`/ping`、`/xx`）安全；
 *   · **不要在这里登记模糊匹配**（比如"包含某个词就响应"）—— 它会抢在关键词库之前/之后，
 *     语义取决于位置，而位置在这张表里看不出上下文。模糊匹配的命令请走原 if 链。
 */
import { pingCommand } from './ping.js'
import { selftestCommand } from './selftest.js'

export const extraCommands = [
  pingCommand,
  selftestCommand,
]
