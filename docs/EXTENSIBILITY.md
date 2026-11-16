# 扩展点：以后加东西该往哪加

> 2026-11-16 立。触发：主人说「**这个是地基，以后还要加别的方法**」。
> 这份文档回答一个问题：**加一个新的 QQ 命令，要动几个文件？**

## 1. 现状（动手前实测）

以 `mcStatus` 为样本，数它在仓库里的**触点**：

| 文件 | 处 | 是什么 |
|---|---:|---|
| `lib/bridge.js` | 8 | featureFlags 清单、if 链分发、处理器实现、… |
| `lib/index.js` | 2 | 配置 schema |
| `lib/help.js` | 1 | 帮助菜单的一行 |
| `lib/panel.js` | 1 | 面板开关 |
| `lib/mcping.js` | 1 | 真正的实现（协议本身） |

⇒ **加一个命令 = 5 个文件、13 处改动**，其中 `bridge.js` 有 1.4 万行。

这就是 SWEBOK 定义的那个量：

> 「**Modifiability** measures the maintainer's effort associated with implementing
> **a specified modification** without introducing defects or degrading existing product quality.」

—— **"实现某个指定修改"的工作量**。我们量出来是 5 文件 / 13 处，可以拿来当基线。

## 2. 文献说了什么（都过 `lit_hardgate.py`，5/5 PASS）

| 结论 | 出处 |
|---|---|
| 可扩展 = **增强产品而不破坏底层结构**，前提是"预见变化" | SWEBOK：`Anticipating change helps software engineers build extensible software, enhancing a software product without disrupting the underlying structure.` |
| 可修改性**是可以量的**（实现某个指定修改的工作量） | SWEBOK：`a specified modification without`（defect / 降质） |
| `command` 是 SWEBOK 列的 Behavioral patterns 之一（不是我们发明的写法） | SWEBOK：`Behavioral patterns (e.g., command,` |
| 模块化的预期收益之一就是"改一个模块不必改其它模块" | Parnas 1972：`make drastic changes to one module without a need to change others` |

⇒ 方向明确：**让"加一个命令"变成"新增一个文件 + 一行注册"**，而不是去改那个 1.4 万行的文件。

## 3. 方案：命令表 + 端口（不是"拆完 42 个命令"）

### 3.1 三个文件

```
lib/commands/registry.js    表 + 分发（形状校验、顺序、命中即停）
lib/commands/mc.js          /mc
lib/commands/fun.js         /fortune + /dice
```

一条命令的形状（`createCommandRegistry` 会校验）：

```js
export const xxxCommand = {
  name: 'xxx',                       // 唯一，重复即启动失败
  traceLabel: '本地功能：xxx',         // 保持原 trace 文案，迁移不改日志
  enabled: (config) => bool,          // 可选；不写就总是尝试
  async run(port, message, text) {},  // 返回 true=命中、false=没匹配
}
```

`port` 是**白名单**，不是整个 Bridge：

```js
{ config, fun, reply }
```

命令文件**不许 import bridge** —— 这条由 `module-gate` 的 `deps:branch-to-trunk` 看守。

### 3.2 加一个新命令的完整步骤

1. 新建 `lib/commands/<名字>.js`，导出上面那个对象；
2. 在 `bridge.js` 构造函数里，把它加进 `createCommandRegistry([...])`；
3. 在 `#onQqMessageInner` 的 if 链里加**两行**（位置由你定，见 §4）：
   ```js
   const xxxHit = await this.#runCommand('xxx', message, text)
   if (xxxHit !== null) { mark('command', true, xxxHit.traceLabel); return }
   ```
4. 有配置项的话，在 `lib/index.js` 的 schema 里加一条（这是 dsh 的契约，绕不开）。

**不需要**再写处理器方法、不需要改分发逻辑。

## 4. 已知取舍（都写下来，别以后当成 bug）

### 4.1 顺序仍然留在 if 链上

命令之间有**真实优先级**：`/读图` 是 OCR 的别名、`/读` 是朗读，顺序错了就整条吃掉
（这个坑在 `#onQqMessageInner` 的注释里记着）。所以 `#runCommand` **不排序**，
顺序在 if 链上看得见。

⇒ 代价：加命令要加两行 if。收益：不会出现"数组顺序碰巧对了"这种隐形依赖。

### 4.2 `help.js` 仍是手写的

`/help` 的 42 条文案不是"命令清单"的机械映射：有的命令不进 help、有的 help 描述多个命令、
顺序按功能分组（基础 → 语音 → 生图 → …）。所以**不从 registry 派生**，
新命令还是要手动加一行 —— 但那一行在 181 行的 `help.js` 里，不在 1.4 万行的 bridge 里。

### 4.3 只迁了 3 个，剩下 39 个按 churn 来

42 个命令一次搬完 = 42 次小迁移，风险累积。现在迁的是**依赖最少**的三个：

| 命令 | 依赖 | 为什么先它 |
|---|---|---|
| `/mc` | `mcping.js` 3 个纯函数 + reply | 精确前缀，与其它命令无交集 |
| `/fortune` | `fortune.js` 纯函数 + reply | 只依赖一个开关 |
| `/dice` | `dice.js` 纯函数 + reply | 同上 |

剩下 39 个按 `docs/MODULARITY.md` §5 的 churn 排序逐个来；
每个迁移的验收同 §5（闸门变小 + 全量绿 + 行为不变）。

## 5. 这一轮的实测结果

| 指标 | 之前 | 之后 |
|---|---|---|
| `bridge.js` 行数 | 14,072 | **14,049** |
| `bridge.js` 字节 | 775,287 | **775,228** |
| 加一个命令的触点（非配置项） | 5 文件 / 13 处 | **3 文件**（新文件 + 注册 1 行 + if 2 行） |
| 闸门 | PASS | PASS（ratchet 没被破，因为行数字节都净减） |

⚠️ 注意最后一行：**加扩展点本身是"净增"**（多一层间接），所以这一轮特意又迁了两个命令
（`/fortune`、`/dice`）来抵消。如果只迁 `/mc`，bridge 会涨 24 行 ⇒ 闸门直接 FAIL。
这不是巧合，是"地基改造必须自带偿还"的意思。

## 6. 下一步

- 39 个命令按 churn 迁（每批 2–3 个，用 `#runCommand` 两行式）
- `dispatchCommand`（批量分发）目前只有单测覆盖、没有生产调用方 —— 等 if 链**整段**
  搬进数组时启用；在那之前它是"留给未来"的 API，别当成死代码删掉
- `port` 加字段要有理由：每加一个，命令能看见的世界就大一圈，反向依赖的风险也大一圈
