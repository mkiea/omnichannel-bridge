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

### 1.5 结构诊断（2026-11-15 实测，`node tools/module-tree.mjs`）

```
lib  70 个文件 / 35,126 行

L0   58 个   叶子：只被依赖，自己不 import 项目内模块
L1    9 个
L2    1 个   cardlook
L3    1 个   bridge.js  14,241 行  ←1 →59   ⚠ 枢纽
L4    1 个   index.js（入口）

环（SCC size > 1）：无 ✓
```

**怎么读这棵树**：L0 有 58 个、L3 只有 1 个 —— 这不是"分层"，是**一颗螺丝钉带着 58 个零件**。
真正的分层每一步都该有若干文件、越往上越少，而不是"底层 58 → 顶上 1"。

**三条可测判据**（不是审美）：

| 判据 | 现在 | 目标 | 依据 |
|---|---|---|---|
| 无环 | ✅ 0 个环 | 保持 0 | `2406.16487`：拆完的子模块必须 acyclic |
| 单文件 fan-out | **59** | ≤10 | 枢纽 = 改一处动一片（`2411.01012` 的静态版本） |
| 层形状 | L0=58 / L1=9 / L2=1 / L3=1 | 每层都有若干文件，最多 2 层只有 1 个 | 见上 |

**目标结构（收敛两级，不是继续平铺）**

```
index.js（根，装配）
└─ bridge/core.js         干：≤800 行、fan-out ≤8
   ├─ inbound.js          收消息 → 闸门 → 路由
   ├─ turn.js             回合 + watchdog + 熔断接线
   ├─ reply.js            出站
   ├─ session.js          会话生命周期
   ├─ commands/*.js       admin / ops / help
   └─ media/*.js          video / voice / image
（枝：lib/*.js 40+，谁都不 import bridge —— 闸门看守）
```

**第一批迁移实测（`#handleHelp` → `lib/help.js`，2026-11-15）**

| 指标 | 迁移前 | 迁移后 | 说明 |
|---|---|---|---|
| `bridge.js` 行数 | 14,361 | **14,241** | −120 |
| `lib` 文件数 | 69 | 70 | +1（`help.js`，169 行） |
| `bridge` fan-out | 58 | **59** | **+1** |
| 环 | 0 | 0 | 不变 |

⚠️ **fan-out 涨 1 是正常的，别拿它判单批成败**：桥还是"什么都自己调"，
多一个模块就多一条边。真正的下降要等 `bridge.js` 自己被拆（第 4–8 批）——
那时子模块各自带自己的边，`core.js` 只剩 6–8 条。
所以单批的验收看**桥的行数**与**它内部的方法块**，fan-out 是终局指标。

## 2. 依据

### 2.1 已过产线（`tools/lit_hardgate.py`，三轮共 **25/25 PASS**，全文在 `调研/fulltext/`）

精读笔记：`调研/软工-大项目模块化-精读-2026-11-15.md`（第一轮 arXiv 四篇 + 第二轮权威两件）。

**第二轮：权威件（补预印本的短板）**

- **Parnas, 1972, CACM 15(12)**（`parnas-1972`，28,656 字符）：
  「**it is almost always incorrect to begin the decomposition of a system into modules
  on the basis of a flowchart**」；正确做法是先列"困难或易变的设计决策"，
  「Each module is then designed to hide such a decision from the others」。
  ⇒ §5 的迁移顺序按"**会变的东西**"切（命令集 / 媒体 / 主动开口策略各自独立变），
  **不按消息流程切**——后者是 Parnas 点名说错的那种切法。

- **SWEBOK Guide V4.0a, IEEE CS, 2024**（`swebok-v4`，1,273,690 字符，411 页）：
  全文 `threshold` 出现 **7 次，无一处是代码规模阈值**；`lines of code` 只出现 1 次且在讲 code tuning。
  关于规模只有一句方向性的话：
  「**Smaller components are easier to understand and, therefore, to maintain.**」
  ⇒ **不存在"权威给出的行数阈值"**。本文档那三个数字只能是工程自定值（见 §2.3）。
  它真正给的是定义：耦合 =「a measure of the interdependence among modules」、
  内聚 =「a measure of the strength of association of the elements within a module」，
  以及「The lack of modularity can adversely affect the development time for subsequent releases」
  —— 缺模块化被定性为**技术债**，不是审美问题。

**第三轮：中文核心期刊（与英文那篇独立地给出同一个答案）**

- **刘弋, 吴毅坚, 彭鑫, 闫亚东.《基于图模型和孤立森林的上帝类检测方法》.
  《软件学报》2022, 33(11): 4046–4060**（`jos-2022-godclass`，31,091 字符）。
  - 上帝类的中文定义是**两条并列**：「包含大量的属性与方法,**并且**与系统中的其他类有多种依赖关系」。
  - 阈值做法：**「将项目中上帝类相关度量指标的平均值作为基准,设计实验确定比例因子,
    并以平均值和比例因子的乘积作为阈值」** —— 随项目走，不是绝对常数。
    ⇒ 与 `2610.32466` 的 median/MAD 规则**独立地得出同一结论**：判据必须相对本项目。
  - 它自己也说「现有方法识别上帝类的能力不强,检测精确率不高」，改进后精确率/F1 才提升
    25.82 / 33.39 个百分点 ⇒ 这不是已解决的问题，自建闸门只能当粗筛。

- **孙昌爱, 金茂忠, 刘超.《软件体系结构研究综述》.《软件学报》2002, 13(7): 1228–1237**
  （`jos-2002-sa-survey`）：大系统软件开发中 **70%** 的错误由需求和设计阶段引入
  ⇒ 支持"早立闸门、分批拆"，而不是等跑不动再一次性重写。

**第一轮：arXiv 四篇**（预印本，已在笔记里标注"未经同行评审"）

1. **任何阈值都只是关于某个语料的陈述。**
   `2610.32466` §1：「The constants are frozen percentiles of a corpus, and
   **a constant derived from a corpus is a statement about that corpus**」。
   那篇自己提的 scale-free 规则（median/MAD，modified z ≥ 3.5）判决也是
   「**The verdict is inconclusive**, and the result that carries forward is **the shape of the errors**」。

2. **复杂度判不出 god unit，差别在耦合。**
   `2610.32466` §10：「**a complexity measure cannot tell the two apart because the difference
   is not in the complexity**」「That is a **coupling question**」。
   `1204.1967`：god class = 职责异质 + 与其他类高耦合 + 体积大（三者并列）。
   `2610.32466` §2：「**Every one of these has a coupling or cohesion clause beside the complexity**」。
   ⇒ **本闸门只覆盖第三条**，这是已知局限（§7）。

3. **模块边界错位有可测代价。** `2411.01012`：本应放一起却被分开的实体对，
   **co-change 多 190%**；20 个项目 / 260,003 个实例。
   但同一篇也警告一次性重模块化没人用得动（「up to 170 move class operations」）。
   ⇒ 拆是值得的，但**必须增量**（§5 的八批）。

4. **拆完的验收是无环 + modularity，不是行数。** `2406.16487`：
   「ensuring **acyclic dependencies** among the decomposed sub-header files is also crucial」，
   好拆分的证据是「higher modularity and acyclic dependencies」。
   ⇒ `deps:branch-to-trunk` 那条规则**不只是代码风格，它是验收项**。

### 2.2 ⚠️ 未过产线（引用时不许当结论）

下面这些是本轮**没有**拿到全文、**没有**过闸的（书籍与经典论文不在 arXiv，本机无全文）：

- Fowler, 2018, *Refactoring*（Large Class / Long Method 属于 Bloaters）
- Martin, *Clean Architecture*（SRP / 依赖倒置）
- Ousterhout, 2018, *A Philosophy of Software Design*（deep modules，反对过度拆分）
- Cockburn, 2005, Ports & Adapters
- MacCormack 等，DSM 的模块化实证（Management Science，付费）

（Parnas 1972 原本也在这一栏，第二轮已补齐 CACM 全文并过闸 —— 见 §2.1。）

它们的**主张方向**仍是本文档的设计依据，但**不能写成"文献已核实"**。
要升级成结论，需要先补全文再跑 `tools/lit_hardgate.py`。

### 2.3 意见（本项目自己的取舍，标清楚是经验值）

- 阈值 800 行 / 120 行 / 80 方法：**没有实证最优值**。主流 linter 都有这类规则
  （ESLint `max-lines`、PMD `ExcessiveClassLength`、Checkstyle `FileLength`），
  但各家默认值差得远，所以本项目不引用任何默认值 —— 只按自己现状定一条能立刻生效的线。
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
| 1 | **✅ 已完成** 帮助文本 | `#handleHelp` 141 行 | → **`lib/help.js`**（181 行） | 低 | 无（2026-11-15） |
| 2 | 运维指令 | `#handleOpsCommand` 735 行 | `bridge/commands/ops.js` | 中 | 端口：`reply / callAction / config / trace` |
| 3 | 管理指令 | 313 + 128 行 | `bridge/commands/admin.js` | 中 | 同上 |
| 4 | 工具注册 | `#registerMediaTools` 200 + `#registerQueryTools` 121 | `bridge/tools-registry.js` | 中 | 端口：`defineTool` 上下文 |
| 5 | 媒体 | 视频 263 + 语音 3 处 + 图片 119 | `bridge/media/*` | 中 | 端口：`server / reply / trace` |
| 6 | 回合 | `#onSessionEvent` 327 | `bridge/turn.js` | 高 | 需先抽出 `entry` 结构定义 |
| 7 | 会话 | `#openSession` 130 + `#installSession` 144 + fork | `bridge/session.js` | 高 | 同 6 |
| 8 | 入站 | `#onQqMessageInner` 1,045 | `bridge/inbound.js` | 极高 | 前 1–7 都完成 |

**每批的验收（四条都要）**

1. `node tools/module-gate.mjs --ratchet` 后 `lib/bridge.js` 的 baseline **变小**；
2. `node tools/test-all.mjs` 全绿；
3. 迁出的文件本身 ≤800 行、函数 ≤120 行（否则等于把债搬了个地方）；
4. **迁"文案 / 纯函数"这类必须留差分基准**：用迁移前的快照做 golden
   （第 1 批的做法见 `test/fixtures/help-golden.json` + `test/help-parity-unit.mjs`：
   42 条文案逐条 + 43 个 `if` 条件多重集）。
   没有它，"少抄了一行字"这种错**永远不会有人发现**——帮助菜单没人会去数行数。

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

## 7. 闸门不能做什么（精读后划界，别把闸门当判决）

这四条必须写在前面，否则下一个人会拿 `npm run gate` 绿了当"结构没问题"的证据。

1. **判不出 god class。** `2610.32466` 的结论是：复杂度度量分不出
   "这是个 god unit"和"这只是个小类在干它该干的活"——「the difference is not in the complexity」。
   我们的四条规则只覆盖"体积"这一维，而 god class 的定义是**三个条件并列**
   （职责异质 / 高耦合 / 体积大，`1204.1967`）。
2. **管不了耦合与 co-change。** 真正决定"该不该拆"的是
   "改一处要改几个文件"（`2411.01012` 的 InSep 对 co-change 多 190%），
   而这需要 `git log` 历史，不是静态行数能算的。
3. **行数是代理指标，且右偏。** 一个 900 行的文件可能是一个内聚模块，
   一个 600 行但 import 了 20 个兄弟模块的文件才是问题。
4. **不阻止"把 300 行搬到新文件、再慢慢长到 800"。**
   所以 §5 的验收里有一条"迁出的文件自己也要 ≤800/≤120"——
   否则拆解只是把债换了个地址。

**下一阶段（有文献支持，本轮不做）**：用 `git log` 算每个文件的 churn，
与行数做二维热点；`高 churn × 大文件` 才是优先拆解对象。
判据与阈值需要单独一轮试验，不能顺手定 —— 而且**下一版阈值要用"相对本仓库"的形式**
（项目内均值 × 因子 / median-MAD），不是再拍一个绝对数：`2610.32466` 与
《软件学报》2022 那篇是两条独立路径，结论一致。

## 8. 完成判据

拆完的标志不是"bridge/ 目录存在"，而是：

1. `tools/module-baseline.json` 里 **`lib/` 下只剩 ≤1 个文件**且 ≤2,000 行；
2. `bridge.js` 的 `maxFunctionLines` ≤120（不再靠 baseline 豁免）；
3. `test:all` 全绿且断言数不减少；
4. 任何一次"加个小功能"都不需要打开 1,000 行以上的文件。
