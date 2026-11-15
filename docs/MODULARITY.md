# 模块化：根 / 干 / 枝 + 硬闸门

> 2026-11-15 立。触发原因：改一行熔断接线要在一个 14,361 行的文件里定位七个位置，
> 而"下次注意"从来没拦住过任何一次加塞。

## 0. 一句话结论

`lib/bridge.js` = **14,361 行 / 792 KB / 297 个方法 / 最长单方法 1,043 行**，
占 `lib/` 全部代码的 41%。它不是"大文件"，是一个 **God Class**：
会话、入站、出站、命令、媒体、主动通道、工具注册、记忆、熔断全在同一个类里。

## 1. 现状（实测数字，不是估计）

```
lib/ 总行数           34,995
lib/bridge.js         14,361   （41%）
lib/onebot.js          1,479
lib/settings-routes.js 1,386
lib/panel.js           1,340
```

`bridge.js` 里 ≥80 行的块有 34 个，合计 6,841 行（占该文件 48%）：

| 行数 | 位置 | 方法 |
|---:|---|---|
| 1,045 | L3227 | `#onQqMessageInner` —— 入站全流程（解析→闸门→路由→回复） |
| 735 | L11953 | `#handleOpsCommand` —— 运维指令编排 |
| 417 | L1058 | `constructor` —— 70+ 个字段初始化 |
| 327 | L11180 | `#onSessionEvent` —— 回合事件 |
| 313 | L2259 | `#execAdminCommand` |
| 311 | L8841 | `#resolveQuoted` |

## 2. 依据（事实与意见分开写）

**事实（可查的文献主张）**

- **Parnas, 1972**, *On the Criteria To Be Used in Decomposing Systems into Modules* (CACM 15/12)：
  模块应按"**可能变化的决策**"切（信息隐藏），而不是按执行顺序切。
  → 直接对应本仓库：按"入站 / 出站 / 命令 / 媒体 / 主动"切，而不是按"消息来了往后走"切。
- **Fowler, 2018**, *Refactoring* (2nd ed.)：`Long Method`、`Large Class` 属于 **Bloaters** 一类；
  对应手法是 `Extract Class` / `Extract Function`。
- **Martin, 2017**, *Clean Architecture*：SRP 的准确表述是"**一个模块只应对一类角色负责**"
  （不是"只做一件事"）；依赖倒置要求高层策略不依赖低层细节。
- **Ousterhout, 2018**, *A Philosophy of Software Design*：主张 **deep modules**——
  小接口、大实现；**反对**把系统拆成一堆浅而碎的小类。
  → 这条是反向约束：拆的目标是"每次改动只落在一个文件"，不是"文件越多越好"。
- **Cockburn, 2005**, Hexagonal Architecture / **Ports & Adapters**：核心逻辑通过端口与外部交互。

**意见（本项目自己的取舍，标清楚是经验值）**

- 阈值 800 行 / 120 行 / 80 方法：没有实证最优值。主流 linter 都有这类规则
  （ESLint `max-lines`、PMD `ExcessiveClassLength`、Checkstyle `FileLength`），
  但**各家默认值差得远**，所以本项目不"引用"任何默认值，只按自己现状定一条能立刻生效的线。
- 先立闸门再拆：拆 14k 行的类风险极高（线上在跑），而闸门零风险。
- 只拆"有独立输入输出"的簇，不为了行数拆纯格式化代码。

## 3. 三层：根 / 干 / 枝

```
根  lib/index.js         装配层：配置 schema、插件注册、生命周期挂载。不许出现业务逻辑。
干  lib/bridge/          运行时骨架：会话表、事件分发、回合驱动、熔断接线。
枝  lib/*.js             功能模块：纯逻辑为主，可单测，不 import 干。
```

**硬规则（由闸门执行，不是约定）**

1. **枝不许 import 干。** 干把能力作为**端口对象**传下去：
   ```js
   // 对
   export async function handleOps(port, message, text)   // port = { reply, callAction, config, trace }
   // 错
   import { QQBridge } from '../bridge.js'
   ```
2. **根是唯一可以 import 干的地方**（装配处）。
3. 新文件超过 800 行 / 函数超过 120 行 / 单类超过 80 方法 ⇒ 直接 FAIL，**没有豁免**。
4. 已超标的 12 个文件登记在 `tools/module-baseline.json`，**只许降不许升**。

## 4. 目标结构

```
lib/
├─ index.js                  根（现在 637 行，schema 已占用大半）
└─ bridge/
   ├─ core.js                干：Bridge 类骨架（会话表 / 生命周期 / 装配），目标 ≤800
   ├─ inbound.js             入站：解析 → 闸门 → 路由（迁 #onQqMessageInner）
   ├─ turn.js                回合：handoff / watchdog / 事件 / 熔断接线
   ├─ reply.js               出站：文本/图片/文件/语音、限流、引用、注入拦截
   ├─ session.js             会话：open / resume / fork / degrade
   ├─ commands/
   │  ├─ admin.js            迁 #execAdminCommand + #handleAdminCommand
   │  ├─ ops.js              迁 #handleOpsCommand（纯函数早已在 lib/ops.js）
   │  └─ help.js             迁 #handleHelp
   ├─ media/
   │  ├─ video.js            迁 #watchVideoFromUrl / #timelineSpeechInner / #showVideo
   │  ├─ voice.js            迁 #fetchVoiceAudioOnce / TTS 编排
   │  └─ image.js            迁 #imageBlocksFor / 附件保存
   ├─ tools-registry.js      迁 #registerMediaTools / #registerQueryTools
   └─ proactive.js           迁 #proactiveEvaluate + tick
```

## 5. 迁移顺序（按耦合升序，一批一个 commit）

| # | 簇 | 现状 | 目标 | 风险 | 前置 |
|---|---|---|---:|---|
| 1 | 帮助文本 | `#handleHelp` 142 行 | `bridge/commands/help.js` | 低 | 无 |
| 2 | 运维指令 | `#handleOpsCommand` 735 行 | `bridge/commands/ops.js` | 中 | 端口：`reply / callAction / config / trace` |
| 3 | 管理指令 | 313 + 128 行 | `bridge/commands/admin.js` | 中 | 同上 |
| 4 | 工具注册 | `#registerMediaTools` 200 + `#registerQueryTools` 121 | `bridge/tools-registry.js` | 中 | 端口：`defineTool` 上下文 |
| 5 | 媒体 | 视频 263 + 语音 3 处 + 图片 119 | `bridge/media/*` | 中 | 端口：`server / reply / trace` |
| 6 | 回合 | `#onSessionEvent` 327 | `bridge/turn.js` | 高 | 需先抽出 `entry` 结构定义 |
| 7 | 会话 | `#openSession` 130 + `#installSession` 144 + fork | `bridge/session.js` | 高 | 同 6 |
| 8 | 入站 | `#onQqMessageInner` 1,045 | `bridge/inbound.js` | 极高 | 前 1–7 都完成 |

**每批的验收（三条都要）**

1. `node tools/module-gate.mjs --ratchet` 后 `lib/bridge.js` 的 baseline **变小**；
2. `node tools/test-all.mjs` 全绿（134 套件）；
3. 迁出的文件本身 ≤800 行、函数 ≤120 行（否则等于把债搬了个地方）。

## 6. 硬闸门

```bash
node tools/module-gate.mjs              # 检查（默认；CI / 提交前）
node tools/module-gate.mjs --json       # 机器可读
node tools/module-gate.mjs --selftest   # 验闸门自己（10 条判据）
node tools/module-gate.mjs --ratchet    # 收紧 baseline（只降不升，涨了就拒绝）
```

- `npm run gate` 同 `node tools/module-gate.mjs`；
- 闸门本身是 `test/module-gate-unit.mjs`，**跟着 `test:all` 一起跑** ——
  闸门最常见的死法是没人跑，不是判错。

**反绕过设计**

| 想绕过 | 为什么不行 |
|---|---|
| 往 baseline 里加一行，把大文件登记进去 | `--init` 只在 baseline 为空时可用 |
| 改大之后再 `--ratchet` | ratchet 检测到"变大"直接拒绝写入 |
| 把代码挪到 `test/` 下 | `test/`、`tools/`、`control/`、`launcher/` 全在扫描范围 |
| 加个新文件放 3,000 行 | 新文件没有 baseline，直接按限值判 |
| 让枝 import 干 | `deps:branch-to-trunk` 规则；正反两面都在 selftest 里验过 |

## 7. 完成判据

拆完的标志不是"bridge/ 目录存在"，而是：

1. `tools/module-baseline.json` 里 **`lib/` 下只剩 ≤1 个文件**且 ≤2,000 行；
2. `bridge.js` 的 `maxFunctionLines` ≤120（不再靠 baseline 豁免）；
3. `test:all` 全绿且断言数不减少；
4. 任何一次"加个小功能"都不需要打开 1,000 行以上的文件。
