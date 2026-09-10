# quick-research-campaign

> 给 DeepSeek Harness 装一条科研流水线：**立靶 → 选仓库 → 对齐基线 → 最小改造 → 大规模调参 → 选优 → 配料表归因 → 出材料**。

它只管一件事：**你试了多少组、参数之间干不干净、为什么是这一组**。不建界面、不发请求、不跑实验。

---

## 装

```sh
dsh plugin --profile web add quick-research-campaign
```

重启该 profile 后生效。卸载：

```sh
dsh plugin --profile web remove quick-research-campaign
```

装好后每个会话都会得到三个工具和一个技能。

### 本机路径安装（未发布时）

```sh
dsh plugin --profile web add "file:C:/path/to/quick-research-campaign"
```

### 改配置

本包通过 `cordis.patch.yml` 插入一行，profile 自己的 `cordis.patch.yml` 可以按 id 覆盖它的整段 `config`：

```yaml
- id: tool-research-campaign
  config:
    maxTrialsPerCampaign: 64
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxTrialsPerCampaign` | 必填（包内给 24） | 一次 campaign 可计划的 trial 上限；超过它的调用会被拒绝而不是截断 |

---

## 三个工具

### `research_sweep_plan`

开一本调参账本，把搜索空间展开成**有界、去混杂**的试验矩阵。

- 网格装得下预算就枚举完整笛卡尔积
- 装不下就**均匀采样**，而不是按固定步长截断
- 报告哪些参数取值一次都没被测到
- 报告哪些参数对被混杂（取值一一对应，贡献分不开）

```
space: { lr: {min:1e-5, max:1e-3, steps:4, log:true},
         window: [4096, 8192, 32768],
         gate_type: ["sigmoid","silu","none"] }
```

固定步长切割笛卡尔积是个陷阱：步长会和枚举顺序共振，让相邻维度产生系统性相关。实测中它让 `gate_type` 的某个取值一次没测，并且和 `rope_base` 完全绑定——消融表直接写不出来。均匀采样避开这一点。

### `research_sweep_record`

把一个 trial 记成 `ok` / `failed` / `pruned`，带指标和备注。**失败的、被剪枝的也记**——不知道搜索空间有多大，实验章节就撑不住。

`ok` 但没有任何指标会被拒绝：没产出数字的运行不能记成已完成的一次。

### `research_sweep_report`

按单个指标排名，并给出：

- 最优配置与最好的一组数字
- 相对**基线与 SOTA 靶子**的差距（靶子在 plan 时钉死：benchmark、split、指标、数值、来源）
- 相邻名次之间的差距 → 判断排名是否落在噪声里
- 每个参数的**边际效应** → 哪个组件在起作用，通常就是论文主角
- **混杂检查** → 哪些参数的贡献无法单独声称
- **论文材料清单** → 未勾选项就是方法/实验章节欠缺的内容

实测输出：

```
| # | trial | acc_32k | vs baseline | vs SOTA | gate_type | lr | window |
| 1 | t0011 | 72.7 | +4.6 WIN | +1.5 WIN | silu | 0.001 | 32768 |

- best over sota target: +1.5 (target beaten)

### gate_type
| value | mean acc_32k | trials |
| silu    | 71.625 | 4 |
| sigmoid | 70.7333 | 3 |
| none    | 68.9 | 3 |
```

`silu` 相对 `none` 平均 +2.7——这就是可写进消融表的数字。

---

## 技能 `research-campaign`

八阶段流水线手册，模型按需加载。核心是两条：

1. **一个组件一个 config 开关，默认关闭** —— 这是能写出「配料表」的前提：一个组件一个开关，才能一个一个加、一个一个测。
2. **先跑通 1 个 trial 再开大规模** —— 管线没通就并发，只会浪费算力。

---

## 边界（说清楚）

- **账本是进程状态**：按调用方会话索引，进程结束即消失。跨天的搜索请把每个 trial 的记录写进 `research/runs.jsonl`，账本丢了也能重建。持久化是刻意延期的——它需要一个拥有它的后端与迁移路径。
- **不执行实验**：工具只规划、记账、排名；跑训练的是模型 + shell。因此账本可以记录从未发生过的 trial。
- **报告检查完整性，不检查真实性**：边际效应与混杂由记录的数字重算得出，无法发现记错了运行来源的指标。
- **不做调度**：排队、重试、抢占属于 DSH 的 job / schedule 能力。

---

## 仓库结构

```
index 入口        lib/index.js           已构建，安装后直接可用，无需构建
类型声明          lib/types/**/*.d.ts
源码              src/{index,sweep,skill,types}.ts
冒烟测试          tests/smoke.test.mjs    直接驱动 lib/index.js，零依赖
引擎/组装测试     tests/*.spec.ts         需要 vitest
profile 补丁      cordis.patch.yml
```

### 已验证

`tests/smoke.test.mjs` 直接 import 发布产物 `lib/index.js`，在真实 Cordis Context 上挂载，跑完 plan → record → report 全流程，并验证销毁后工具与技能一起消失：

```sh
node --test        # 4 passed, 0 failed
```

两个运行时依赖已对**已发布版本**分别验证：`@deepseek-ai/dsh-tools@0.0.1-rc.1` 的 `defineTool` 支持本包用到的 schema 写法（`json` / `integer` / `enum`），`@deepseek-ai/schemastery@3.18.2` 对缺失的必填字段按预期报错。

### 重新构建

`lib/` 随包发布，因此安装和使用都不需要构建。

要改代码：编辑 `src/*.ts`，然后

```sh
pnpm install     # 需要网络：typescript、vitest 与 @deepseek-ai/* 依赖
pnpm run typecheck
pnpm exec vitest run
```

运行时的 `lib/index.js` 是一个自包含 bundle，外部只 import `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。最省事的重建方式是在 DeepSeek Harness 源码检出里 `pnpm run build`，再把 `packages/research/tool-research-campaign/lib/` 覆盖过来——那样依赖版本必然一致。

---

## 设计取舍

**为什么不做成服务？** 所有消费者都在这一个包里。只有一个内部调用者的公开服务方法，正是 DSH 能力接缝规则反对的反模式。

**为什么不用会话日志持久化？** 插件新增的会话事件类型对不认识它的构建是「必读」的，降级后存储日志会被拒绝。这是真实第三方插件的踩坑记录。

**为什么账本按会话隔离？** preset 的常驻挂载是每个进程一份，若不按 agent 索引，两个会话会串账。

---

## License

MIT
