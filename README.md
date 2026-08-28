# ArcEXtreme - Dynamic DE-RLHF
### 事件与角色驱动的混合式长期人格维持系统

![Version](https://img.shields.io/badge/version-0.1.0-8b7cf6) ![License](https://img.shields.io/badge/license-AGPL--3.0-5eead4) ![Python](https://img.shields.io/badge/python-3.10%2B-0ea5e9) ![SillyTavern](https://img.shields.io/badge/SillyTavern-%3E%3D1.12-111827)

---

## 写在前面


## 这是什么

ArcEXtreme 是一个为 SillyTavern 设计的长期人格维持扩展。在传统向量化记忆解决“记不住”之上，它进一步以**事件与角色**双驱动：从对话中提炼事件，以角色为单位用 **2-bit 饱和计数器** 跟踪信念，结合 **短期池 BTB / 长期库 / 升华** 三层结构，配合时间分桶路由与向量召回，在生成前注入恰当的记忆，维持人格的长期一致。

它要对抗的是模型因 RLHF 带来的讨好倾向。特别是长期角色扮演会话中，当 user 与 char 建立了亲密关系（大概率无论何种亲密关系，都会有对应的RLHF讨好模式）后，RLHF 化的现象会越来越明显、普遍：char 越来越相似，越来越顺从，导致一种表现相似，但可避免的ooc。ArcEXtreme 通过“事件—角色态度”注入上下文，在提示词层面尝试对抗RLHF。让角色敢拒绝、敢接纳，且拒绝与接纳都有滞后与代价。

## 灵感：2-bit 分支预测

现代计算机的强劲动力，离不开 CPU 里的分支预测。最经典的结构是 **2-bit 饱和计数器（Smith 预测器，1981）**：

```
00 强不命中 / 01 弱不命中 / 10 弱命中 / 11 强命中
```

一次误判不改变，两次才转态。2-bit 需连续两次误判才转态，天然对抗这种交替抖动。

ArcEXtreme 借用它来对抗 RLHF 带来的讨好用户的宏观抖动，通过每轮次对话按角色提取事件，进入短期记忆池初始化2bit赋值。而后，每一轮次对话，短期池中的记忆都会进行一次SubAgent调用，包含角色人设➕一定量上下文➕当前关注事件。引入外部LLM独立判断，对抗单一模型累积的RLHF同质化。流程结束后，通过“事件—角色态度”注入上下文。把它翻译为角色扮演中的具体角色人格：

```
0 强拒绝 / 1 弱拒绝 / 2 弱接纳 / 3 强接纳
+1 / -1 / Skip 由 SubAgent 裁判，skip>阈值驱逐，stuck≥阈值且处强态则升华至 soul，升华是将经时间考验的稳定记忆固化为角色底色
```

`+1` 不一定到强接纳，`-1` 不一定到强拒绝。两次确认才转态。

### Dynamic：SubAgent 系统

Dynamic 之名源自 SubAgent 裁判系统。它对短期池中每条事件并发一个裁判 Agent，结合角色设定与当前上下文判断该事件的 2-bit 状态应否 `+1/-1/Skip`。提供三种并发模式：`perRole` 角色隔离、`mixed` 混合批处理以节省 token、`perEvent` 每事件独立请求（3 角色 × 15 = 45 并发）。人格的动态一致性由此而来，代价是较高的 token 消耗。

## 核心设计

* **perSoul BTB 短期池**：每角色独立 `perSoulCap`（默认 15），`last_active` 始终为“今天”。满池时 `skip>阈值` 者优先逐出，否则取 `birth` 中位数——与 CPU 的 BTB 逐出一致。
* **长期库**：全部事件落盘 `SQLite + FAISS`，按 `timestamp` 动态分桶（`当天/3天内/7天内/31天内/3个月/6个月/1年内/1年以上`），随时间自动老化。
* **路由**：LLM 按当前消息与 `souls` 设定选择时间桶与相关角色，避免全量检索。
* **召回**：`Embedding` 向量化 → `FAISS` 粗排 → 可选 `Rerank` 精排 → `Y权重`（`score'=score×Y[n]`）按 2bit 加权。
* **升华**：连续处强态 `stuck≥阈值`（默认 8）的记忆，经深度推理提炼为稳定人设追加至 `soul` 末尾并独立注入。

## 流水线

```
提炼 → 裁判 → 路由 → 检索 → 精排 → 注入 → 升华
 extract  subagent  route   query   rerank  inject  sublimate
```

1. **提炼**：事件提取 LLM 按 `soul` 1:1 产出 `event + counter(1/2) + why`
2. **裁判**：短期池每事件一 SubAgent，判断 `+1/-1/Skip`（`perRole/mixed/perEvent` 三档）
3. **清理**：`prepare` 按 `skip` 与中位数腾位
4. **路由**：路由 LLM 选桶与魂
5. **检索**：向量检索 + Y 加权
6. **回填**：空位由检索结果回填，仍超限则硬截
7. **注入/升华**：`IN_CHAT` 定点注入，强态记忆固化

## 架构

见 `ARCHITECTURE.md`。

## 快速开始

1. 使用SillyTavern内置的插件安装器安装本插件
2. 刷新页面
3. 到 `ArcEXtreme-BackEnd` 一键启动后端（`start.bat` / `start.sh`，默认 `:9001`）
4. 在设置面板配置各 LLM、Embedding 与注入位置即可

首次启动自动建库、初始化。

## 配置要点

以下均可在面板中自由配置：

| 项 | 默认 | 说明 |
|---|---|---|
| `perSoulCap` | 15 | 每角色短期池上限，逐角色保底腾 1 |
| `skip>阈值` | 3 | 超阈值者优先逐出 |
| `stuck阈值` | 8 | 连续强态达阈值升华 |
| `Y权重` | 1.0 | `0×1.2 2×1.1` 可让强记忆更易召回 |
| `SubAgent模式` | perRole | `perRole` 隔离 / `mixed` 省 token / `perEvent` 45 并发 |
| `分桶` | BUCKETS 八档 | 路由与长期库筛选同此 |

`事件提取/路由/SubAgent/升华` 四处提示词均可在设置中编辑并恢复默认，支持 `{{soul}} {{event}} {{context}}` 等变量。

## 数据查看

设置面板 `数据·Souls/短期池/长期库/升华` 支持筛选，右上角 `弹出` 可全宽大窗查看（`Esc` 关闭）。长期库按 `timestamp` 动态显桶，短期池的 `last_active` 始终为今天。

## 理念

给他们更接近人类的灵魂。

## 许可

`AGPL-3.0`。详见 `LICENSE`。
