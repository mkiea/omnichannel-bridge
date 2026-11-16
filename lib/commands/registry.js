/**
 * commands/registry.js —— 命令分发的扩展点（2026-11-16）
 *
 * 为什么要有它：主人说「这个是地基，以后还要加别的方法」。
 * 现在的现实是：**加一个命令要改 5 个文件**（实测 `mcStatus` 的触点）——
 * `lib/index.js`（schema）、`lib/bridge.js`（featureFlags 清单 + if 链分发 + 处理器）、
 * `lib/help.js`（菜单）、`lib/panel.js`（面板）。其中 `bridge.js` 有 1.4 万行，
 * 改它的成本最高、风险最大，而它恰恰是**每次加功能都必须动**的那一个。
 *
 * 文献给的判据正好是"可修改性"：SWEBOK 把它定义成
 * 「**a specified modification** 所需的工作量，且不引入缺陷」——
 * 也就是"加一个命令要动几处"是可以量的，不必凭感觉。
 * 而 `command` 这个写法本身在 SWEBOK 的 Behavioral patterns 清单里（不是我们发明的）。
 *
 * 目标不是"把 42 个命令一次搬完"（那是 42 次小迁移，风险累积），而是：
 * **先把扩展点建好，让下一个命令不用再碰 bridge**。旧命令按 churn 逐个迁。
 *
 * ── 扩展一个命令要做的事（这就是契约）──────────────────────────────
 *   1. 新建 `lib/commands/<名字>.js`，导出 `{ name, enabled?, run, help? }`；
 *   2. 把它加进 `bridge` 里的 `this.commands` 数组；
 *   3. 如果它有自己的配置项，在 `lib/index.js` 的 schema 里加一条。
 *   —— 不需要改 `bridge.js` 的分发逻辑，不需要改顺序判断。
 *
 * ── 为什么 run 返回 boolean 而不是抛"未匹配" ──────────────────────
 * 现有 42 个处理器都已经是这个形状（`if (!match) return false`），
 * 保持它意味着**迁移是纯搬家**，不需要重写每个命令的匹配逻辑 —— 那才是风险源。
 *
 * ── 为什么 dispatch 不吞异常 ─────────────────────────────────────
 * 一个命令抛错，应该冒到调用方（它本来就在 `#onQqMessageInner` 的 try 里），
 * 由那里统一记 trace。如果这里 catch 掉，排查时看到的是"命令没反应"，
 * 而真正的原因被埋在下游 —— 本仓库在这条上栽过（见 `qq-host-health.json` 的历史 issue）。
 */

/**
 * 建一个命令表。**只做形状校验**，不做排序 —— 顺序就是数组顺序，
 * 因为命令之间有真实的优先级（`/读图` 是 OCR 别名、`/读` 是朗读，先后不能错）。
 *
 * @param {Array<{name: string, enabled?: Function, run: Function, help?: Function, traceLabel?: string}>} specs
 */
export function createCommandRegistry(specs) {
  if (!Array.isArray(specs)) throw new TypeError('createCommandRegistry: 需要数组')
  const seen = new Set()
  return specs.map((spec) => {
    if (spec === null || typeof spec !== 'object') throw new TypeError('createCommandRegistry: 每项要是对象')
    const name = String(spec.name ?? '').trim()
    if (name === '') throw new TypeError('createCommandRegistry: 每项必须有 name')
    if (seen.has(name)) throw new TypeError(`createCommandRegistry: 命令名重复 ${name}`)
    seen.add(name)
    if (typeof spec.run !== 'function') throw new TypeError(`createCommandRegistry: ${name} 缺 run()`)
    if (spec.enabled !== undefined && typeof spec.enabled !== 'function') {
      throw new TypeError(`createCommandRegistry: ${name} 的 enabled 必须是函数`)
    }
    return {
      name,
      enabled: spec.enabled,
      run: spec.run,
      help: spec.help,
      // trace 文案保持原样：迁移不该顺手改日志（否则看日志的人会以为行为变了）
      traceLabel: String(spec.traceLabel ?? `命令 ${name}`),
    }
  })
}

/**
 * 按顺序试每条命令，第一条返回 `true` 的算命中。
 *
 * @param {ReturnType<typeof createCommandRegistry>} registry
 * @param {{config: object}} port 端口对象（命令只许用它，不许碰 Bridge）
 * @param {object} message
 * @param {string} text
 * @returns {Promise<{name: string, traceLabel: string} | null>} 命中信息，没命中返回 null
 */
export async function dispatchCommand(registry, port, message, text) {
  for (const command of registry) {
    if (command.enabled !== undefined && !command.enabled(port.config)) continue
    const hit = await command.run(port, message, text)
    if (hit === true) return { name: command.name, traceLabel: command.traceLabel }
  }
  return null
}
