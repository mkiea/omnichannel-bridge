/**
 * moments-log.js —— 说说子系统的两件「记账」（2026-11-16 从 `bridge.js` 抽出）
 *
 * 这两个都很小（11 + 10 行），但都**不持有状态**：
 *   · `logMoment`：往事件流写一条 + 往 `qq-moments.log` append 一行；
 *   · `noteUnsupported`：判断"这个错误是不是后端不支持"，是就交给调用方**记一次**。
 *
 * ⚠️ 锁存 `momentsUnsupported` **不在这里**：它有 3 处跨模块使用
 * （管理命令写、主动通道读、发布写），归 bridge。模块只拿 `isUnsupported()` /
 * `markUnsupported()` 两个函数 —— 状态留在协调者手里，模块只做判断。
 */
import { appendFileSync, mkdirSync } from 'node:fs'

/** 事件流一条 + 文件一行。写不了不影响主路径（日志失败不该让发布失败）。 */
export function logMoment(port, line) {
  port.eventsLog({ type: 'moment', line: String(line).slice(0, 200) })
  try {
    mkdirSync(port.memoryDir, { recursive: true })
    appendFileSync(port.momentsLogFile, `${new Date().toISOString()}\t${line}\n`, 'utf8')
  } catch { /* 日志写不了不影响主路径 */ }
}

/**
 * 记下"当前后端不支持发说说"。
 *
 * 判据是后端回的 `retcode 1404 / 不支持的 API`，**不是**"发失败了"——
 * 网络抖动、DLP 拦下、文本为空都会让 sendQzoneMsg 抛错，那些不该停用整个由头。
 *
 * @returns {boolean} true 表示确实是不支持（已调用过 `markUnsupported`）
 */
export function noteUnsupported(port, error) {
  const message = String(error?.message ?? error ?? '')
  if (!/不支持的 API|"retcode":1404/.test(message)) return false
  if (port.isUnsupported() !== null && port.isUnsupported() !== undefined) return true
  port.markUnsupported({ at: Date.now(), reason: message.slice(0, 160) })
  port.logger?.warn?.(`QQ 空间（说说）在当前后端不可用：${message.slice(0, 80)} —— 主动通道已停用这条由头，其余功能不受影响`)
  port.debugLog(`moments unsupported, disabled for this session: ${message.slice(0, 120)}`)
  return true
}
