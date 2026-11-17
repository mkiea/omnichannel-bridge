/**
 * `/自检` 的判据单测（2026-11-17）
 *
 * 起因是一次**真机假红**：第一版把「provider 为空」判成 ❌，真机上直接报了
 * 「❌ 模型配置：provider 或 model 为空」，但聊天其实是通的 ——
 * 因为**插件配置为空是正常状态**（= 跟随宿主），而宿主那侧的
 * `agentDefaultModel.currentSelection()` 在真机上返回空。
 *
 * 教训：**"读不到"不等于"坏了"**。这条单测就是钉住三档判级。
 *
 * 判据：
 *   T1 插件自己配了        → ✅ 且说清是插件覆盖
 *   T2 插件空、宿主读得到   → ✅ 且说清是跟随宿主
 *   T3 两边都读不到        → ⚠️（不是 ❌）
 *   T4 报告末尾一定是"只读"声明（它会被随手发，必须自证不改状态）
 */
import { selftestCommand } from '../lib/commands/selftest.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

async function report(config, runtime = {}) {
  const out = []
  const port = { config, runtime: { socket: () => null, probeTts: () => Promise.resolve(false), ...runtime }, reply: async (_m, t) => out.push(t) }
  const hit = await selftestCommand.run(port, {}, '/自检')
  return { hit, text: out.join('') }
}

// T1 插件自己配了
{
  const { hit, text } = await report({ provider: 'p1', model: 'm1' })
  check('T1 /自检 命中', hit === true)
  check('T1 插件配置 ⇒ ✅ 且标明来源', /✅ 模型配置：p1 \/ m1（插件配置覆盖）/.test(text), text.split('\n')[1] ?? '')
}

// T2 插件空、宿主读得到
{
  const { text } = await report({}, { hostModel: () => ({ provider: 'hp', model: 'hm' }) })
  check('T2 跟随宿主 ⇒ ✅（不是红）', /✅ 模型配置：跟随宿主/.test(text), text.split('\n')[1] ?? '')
}

// T3 两边都读不到 —— 这条是这次真机假红的根因
{
  const { text } = await report({}, { hostModel: () => ({}) })
  check('T3 两边都读不到 ⇒ ⚠️ 而不是 ❌', /⚠️ 模型配置/.test(text) && !/❌ 模型配置/.test(text), text.split('\n')[1] ?? '')
  // 头部计数要**只反映真坏项**：这一档 socket 返回 null（连接没起），所以是 1 项，
  // 且那 1 项是"平台连接"、不是"模型配置" —— 第一版我写成"应该全绿"，错了。
  check('T3 头部只统计真坏项（连接没起 ⇒ 1 项）', /自检（❌ 1 项坏了）/.test(text), (text.split('\n')[0] ?? '').slice(0, 40))
  check('T3 那 1 项是连接不是模型', /❌ 平台连接/.test(text) && !/❌ 模型配置/.test(text))
}

// T4 只读声明
{
  const { text } = await report({ provider: 'p', model: 'm' })
  check('T4 报告末尾有"只读"声明', /只读检查/.test(text))
  check('T4 报告里没有"发了/建了"这类动作暗示', !/我已|已发送|已创建/.test(text))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
