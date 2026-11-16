# 接一个新平台要做什么

> 2026-11-16 立。触发：主人说「这个是**双向桥接层**，后面可能接入别的软件」。
> 这份文档回答：**把微信 / Discord / 别的聊天系统接进来，具体要写什么**。

## 1. 契约是**从代码反推**的，不是照搬理论

数了 `bridge.js` 里的 **66 个 `this.server.xxx()` 调用点**之后才发现，它们根本不是一类东西：

| 类别 | 例 | 次数 | 判断 |
|---|---|---:|---|
| 每个平台都得有 | `currentSocket` / `sendSegments` / `sendText` / `getMsg` / `getLoginInfo` / `on` / `off` / `callAction` | 33 / 16 / … | **必需** |
| QQ 特有的概念 | `getQunAlbumList`（群相册）/ `groupTodo`（群待办）/ `groupSign`（群签到）/ `sendLike`（名片赞） | 各 1 | **可选** |

⇒ 契约分两层：`REQUIRED` 缺一条就起不来；`OPTIONAL` 缺了只让对应功能降级。

代码：`lib/platform-adapter.js`。测试：`test/platform-adapter-unit.mjs`（14 条）。

## 2. 必需 8 项（缺任何一条，bridge 起不来）

```js
on(event, handler)                                   // 'message'/'notice'/'request'/'bot-connect'/'bot-disconnect'
off(event, handler)                                  // 停机摘监听（漏了 S6 会抓）
currentSocket()                                      // 出站要一个"当前活跃连接"
sendSegments(socket, messageType, targetId, segments) // 唯一的出站主路径
sendText(socket, messageType, targetId, text)         // 短回执
getMsg(socket, messageId, opts)                       // 引用解析
getLoginInfo(socket) => { user_id, nickname }          // 身份探针
callAction(action, params)                            // 其余 action 的通用出口
```

**这 8 个覆盖"收 → 认人 → 回"的最小闭环**。做到这一步，就能聊天了。

## 3. 可选 9 组 63 项 —— 缺了会怎样

| 组 | 缺了以后用户看到什么 |
|---|---|
| `groupAdmin` | 群管理指令（踢/禁言/名片/头衔/公告/入群审批）全部不可用 |
| `groupInfo` | 群信息/成员查询不可用 |
| `groupFiles` | 群文件不可用 |
| `groupAlbum` | 群相册不可用 |
| `groupTodo` | 群待办不可用 |
| `interaction` | 戳一戳/名片赞/贴表情/已读不可用（**主动通道的"轻互动"由头会全部跳过**） |
| `messageOps` | 撤回、合并转发、精华、图片/语音直取、OCR 不可用 |
| `friends` | 好友列表与申请不可用 |
| `testHooks` | 只影响测试 |

⚠️ **这张表存在的唯一理由**：能力缺失时的表现是"某个命令没反应，日志里什么都没有" ——
这是最难排查的一类问题。接新平台的人应该先看这张表，而不是等用户来报。

## 4. 实测：现网实现是满的

`test/platform-adapter-unit.mjs` 的 A3 直接拿 **`OneBotServer` 的真实实例**跑 `inspectAdapter()`：

```
必需 8 项：齐
可选 9 组：一个不缺
未知方法：0 个
```

⇒ 契约不是编的，它和现网实现一致。**这条断言的意义**：如果哪天契约写错（列了不存在的方法），
A3 会立刻红——因为真实实现会对不上。

## 5. 接新平台的三步

1. **实现 `REQUIRED` 8 项**（能做到收消息、回消息、查身份）
2. **入站侧把平台消息转成统一形状** —— 参考 `lib/onebot.js` 的 `parseMessage`，
   产出的形状是 `{ bot, userId, messageType, groupId, text, atMe, ats, reply, records,
   images, files, forwards, videos, messageId, senderName, raw }`
3. **按需补 `OPTIONAL`**，没补的那些对照 §3 的表就知道会灰掉什么

然后把 `new QQBridge(ctx, config, <你的适配器>, logger)` 换掉第三个参数即可
（`bridge.js` 里所有出站都走 `this.server`，没有别的地方直连协议）。

## 6. 一个刻意的取舍：**没有**在 `start()` 里做校验

试过在 `bridge.start()` 里加 `inspectAdapter` 告警，被 `module-gate` 拦了（+4 行 / +323 字节，
ratchet 只许降）。

当时可以选择"挪出 4 行来还债"，但判断是**不值得**：
- 契约已经被**测试**钉住了（A3 用真实实现跑），比启动时 warn 一句更强；
- 那 4 行换来的只是一个日志，而"接新平台"是一次性动作，那时跑一次测试就够了。

⇒ 所以现在的形态是：**契约 + 校验器 + 测试**，生产代码里不调用。
如果以后真的接了第二个平台，第一步应该是把 `inspectAdapter(adapter)` 接进启动流程 ——
**那时它是刚需，现在还不是。**
