/**
 * platform-adapter.js —— 平台适配器的**契约**（2026-11-16）
 *
 * 起因：主人说「这个是双向桥接层，后面可能接入别的软件」。而现在的实际情况是
 * `bridge.js` 里有 **66 个 `this.server.xxx()` 调用点**，接口是**隐式**的 ——
 * 接第二个平台时，没人知道要实现哪些方法、哪些可以不做、不做会怎样。
 *
 * ⚠️ 这里是**从代码反推**的，不是照搬"六边形架构"的教条：
 * 数了 66 个调用点之后才发现，它们根本不是一类东西 ——
 *   · `currentSocket`（33 次）/ `sendSegments`（16 次）/ `sendText` / `getMsg` /
 *     `getLoginInfo` / `on` / `off` / `callAction`：**每个平台都得有**，没有就聊不了天
 *   · 群相册、群精华、群待办、群签到、名片赞、戳一戳……：**QQ 特有的**，
 *     微信/Discord 根本没有这些概念
 * 所以契约必须是**两层**：`REQUIRED` 缺一条就起不来；`OPTIONAL` 缺了只让对应功能降级。
 *
 * 这不改变任何调用方式（bridge 仍然直接 `this.server.xxx`），只是把**已经存在的
 * 隐式契约写下来**，并提供一个能在启动时失败的校验器。
 *
 * 接一个新平台的最小工作量（按当前代码统计）：
 *   1. 实现 `REQUIRED` 8 项 —— 能做到"收消息、回消息、查身份"；
 *   2. 入站侧把平台消息转成统一形状（参考 `lib/onebot.js` 的 `parseMessage`）；
 *   3. 其余功能按需补 `OPTIONAL`，没补的那些会**静默不可用**（见 `CAPABILITY_MAP`）。
 */
import { EventEmitter } from 'node:events'

/**
 * **必需**：缺任何一条，bridge 起不来或每条消息都会炸。
 * 判定依据是调用次数 + 语义：这 8 个覆盖"收 → 认人 → 回"的最小闭环。
 */
export const REQUIRED = Object.freeze([
  'on',                // (event, handler) —— 'message' / 'notice' / 'request' / 'bot-connect' / 'bot-disconnect'
  'off',               // (event, handler) —— 停机时摘监听（漏了会泄漏，S6 抓）
  'currentSocket',     // () => socket —— 出站要一个"当前活跃连接"
  'sendSegments',      // (socket, messageType, targetId, segments) —— 唯一的出站主路径
  'sendText',          // (socket, messageType, targetId, text) —— 短回执
  'getMsg',            // (socket, messageId, opts) => full —— 引用解析
  'getLoginInfo',      // (socket) => { user_id, nickname } —— 身份探针
  'callAction',        // (action, params) => result —— 其余 action 的通用出口
])

/**
 * **可选**：缺了只让对应功能不可用。分组是为了让"接新平台时要补什么"看得清。
 * 组名是中性的（不写 QQ 术语），但括号里标了它在 QQ 上对应什么。
 */
export const OPTIONAL_GROUPS = Object.freeze({
  /** 群管理（踢/禁言/名片/头衔/公告/申请审批…）—— 微信/Discord 的能力模型完全不同 */
  groupAdmin: [
    'setGroupKick', 'kickGroupMembers', 'setGroupBan', 'setGroupWholeBan', 'setGroupCard',
    'setGroupAdmin', 'setGroupSpecialTitle', 'setGroupLeave', 'setGroupAddRequest',
    'setGroupAddOption', 'setGroupMemberPermissions', 'setGroupMemberInvitePolicy',
    'setGroupNewMemberHistoryVisibility', 'setGroupProfile', 'renameGroupFile',
    'sendGroupNotice', 'getGroupNotice', 'getGroupSystemMsg', 'getGroupSignedList',
    'getGroupShutList', 'getGroupIgnoredNotifies', 'getGroupAtAllRemain', 'groupSign',
  ],
  /** 群信息读取 */
  groupInfo: [
    'getGroupInfo', 'getGroupInfoEx', 'getGroupMemberList', 'getGroupMemberInfo',
    'getGroupList', 'getGroupHonorInfo',
  ],
  /** 群文件（QQ 独有概念） */
  groupFiles: [
    'getGroupRootFiles', 'getGroupFilesByFolder', 'getGroupFileUrl',
    'uploadFile', 'deleteGroupFile', 'createGroupFileFolder', 'moveGroupFile', 'getFile',
  ],
  /** 群相册（QQ 独有概念） */
  groupAlbum: ['getQunAlbumList', 'uploadImageToQunAlbum'],
  /** 群待办（QQ 独有概念） */
  groupTodo: ['groupTodo'],
  /** 互动（戳一戳/名片赞/贴表情/已读） */
  interaction: [
    'groupPoke', 'friendPoke', 'sendLike', 'setMsgEmojiLike', 'getEmojiLikes',
    'markPrivateMsgAsRead', 'markGroupMsgAsRead', 'setInputStatus',
  ],
  /** 消息管理（撤回/精华/合并转发/取媒体） */
  messageOps: [
    'deleteMsg', 'sendForwardMsg', 'getForwardMsg', 'getImage', 'getRecord',
    'setEssenceMsg', 'deleteEssenceMsg', 'getEssenceMsgList', 'ocrImage',
  ],
  /** 好友与申请 */
  friends: [
    'getFriendList', 'setFriendAddRequest', 'setDoubtFriendsAddRequest', 'getDoubtFriendsAddRequest',
  ],
  /** 测试钩子（dry-run 只在不接真后端时用） */
  testHooks: ['setDryRun', 'takeDryRunCalls'],
})

/** 扁平化的可选方法名集合。 */
export const OPTIONAL = Object.freeze(
  Object.values(OPTIONAL_GROUPS).flat(),
)

/**
 * 能力 → 会受影响的功能。**这张表是给"接新平台的人"看的**：
 * 少实现一组，用户会看到"某个命令没反应"，而日志里什么都没有 —— 这是最难排查的一类。
 */
export const CAPABILITY_MAP = Object.freeze({
  groupAdmin: '群管理指令（!踢/!禁言/!名片/!头衔/!公告/入群审批）全部不可用',
  groupInfo: '群信息/成员查询（/群信息、!成员、!群荣誉）不可用',
  groupFiles: '群文件（/群文件、!上传、!删文件）不可用',
  groupAlbum: '群相册（/相册）不可用',
  groupTodo: '群待办（/待办）不可用',
  interaction: '戳一戳/名片赞/贴表情/已读回执不可用（主动通道的"轻互动"由头会全部跳过）',
  messageOps: '撤回、合并转发、精华消息、图片/语音直取、OCR 不可用',
  friends: '好友列表与好友申请不可用',
  testHooks: '只影响测试（dry-run 记录），不影响真实运行',
})

/**
 * 校验一个适配器实现。
 *
 * @param {object} impl
 * @returns {{ok: boolean, missing: string[], groups: Record<string, string[]>, unknown: string[]}}
 *   `missing` 非空 ⇒ 不能当平台适配器用（启动就该失败）
 */
export function inspectAdapter(impl) {
  const missing = []
  if (impl === null || typeof impl !== 'object') {
    return { ok: false, missing: [...REQUIRED], groups: {}, unknown: [] }
  }
  for (const name of REQUIRED) {
    if (typeof impl[name] !== 'function') missing.push(name)
  }
  // `on`/`off` 允许来自 EventEmitter 原型（QQ 的客户端就是继承它），这里统一按可调用判断
  const groups = {}
  for (const [group, names] of Object.entries(OPTIONAL_GROUPS)) {
    const lack = names.filter((n) => typeof impl[n] !== 'function')
    if (lack.length > 0) groups[group] = lack
  }
  const known = new Set([...REQUIRED, ...OPTIONAL, 'off', 'on'])
  const unknown = Object.keys(impl).filter((k) => typeof impl[k] === 'function' && !known.has(k))
  return { ok: missing.length === 0, missing, groups, unknown }
}

/**
 * 启动时调用：必需项缺失直接抛。**在构造期炸，比"第一条消息没反应"好排查得多。**
 * @param {object} impl
 * @param {string} [label] 报错里带的名字（如 'qq/onebot'）
 */
export function assertAdapter(impl, label = 'platform adapter') {
  const info = inspectAdapter(impl)
  if (!info.ok) {
    throw new TypeError(
      `${label} 缺少必需方法：${info.missing.join(', ')}`
      + '（契约见 lib/platform-adapter.js 的 REQUIRED）',
    )
  }
  return info
}

/** 人读的支持矩阵（接新平台时打印一次，就知道哪些功能会是灰的）。 */
export function describeAdapter(impl) {
  const info = inspectAdapter(impl)
  const lines = [`必需 ${REQUIRED.length} 项：${info.ok ? '齐' : `缺 ${info.missing.join(', ')}`}`]
  for (const [group, label] of Object.entries(CAPABILITY_MAP)) {
    const lack = info.groups[group]
    lines.push(`  ${lack === undefined ? '✅' : '⬜'} ${group}${lack === undefined ? '' : `（缺 ${lack.length} 项）`} —— ${label}`)
  }
  return lines.join('\n')
}

/** 默认导出：让 `instanceof` 之外的用法（如 `new EventEmitter()` 风格）也能被识别。 */
export const ADAPTER_SHAPE = Object.freeze({ REQUIRED, OPTIONAL, OPTIONAL_GROUPS })

// 供测试用：一个最小可用的内存适配器（只实现必需 8 项）
export function createMemoryAdapter() {
  const bus = new EventEmitter()
  return {
    on: (event, handler) => { bus.on(event, handler); return undefined },
    off: (event, handler) => { bus.off(event, handler) },
    emit: (event, payload) => bus.emit(event, payload),   // 测试注入用（不属于契约）
    currentSocket: () => ({ readyState: 1, OPEN: 1, send() {}, close() {} }),
    async sendSegments() { return { message_id: 1 } },
    async sendText() { return { message_id: 1 } },
    async getMsg() { return null },
    async getLoginInfo() { return { user_id: 0, nickname: '' } },
    async callAction() { return {} },
  }
}
