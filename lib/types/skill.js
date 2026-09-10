/**
 * The research-campaign skill body: the eight-stage playbook that takes one
 * idea to a paper's methods and experiments sections, plus the bookkeeping
 * rules that make the resulting numbers defensible.
 *
 * The text is model-visible, so it is pinned verbatim here as its one home and
 * quoted in the package README.
 *
 * @module @deepseek-ai/dsh-tool-research-campaign/skill
 */
/** One-line catalogue description; the model reads this before loading the body. */
export const SKILL_DESCRIPTION = '把一句 fancy idea 推进成能写论文的实验章节：仓库选型与改造、大规模调参账本、选优排名、配料表归因与论文表格。';
/** Catalogue routing hint; decides whether the model loads this skill. */
export const SKILL_WHEN_TO_USE = '当任务涉及复现基线、改造开源仓库、设计或运行超参搜索、对标 SOTA 数字、做消融实验、或准备论文的方法与实验章节时使用。';
/** The complete skill body loaded on demand. */
export const SKILL_CONTENT = [
    '# Research Campaign — 从一句 idea 到能写论文的实验章节',
    '',
    '## 目标',
    '把一句 fancy idea 变成论文的实验章节：找到可改造的仓库、做出最小改造、大规模调参、选出最好的一组数字、把每个工程组件归因清楚。',
    '',
    '## 阶段',
    '',
    '### 1. 立靶',
    '先把要打败的数字钉死：benchmark 与版本、split、主指标与方向、当前最好值、报告来源，以及协议差异（模型规模、分辨率、训练数据、评测脚本）。',
    '用 research_sweep_plan 的 sota_* 字段把靶子写进账本，用 baseline_metrics 记录底座原始指标。没有靶子就不要开始调参。',
    '',
    '### 2. 选仓库',
    '搜 GitHub 与论文官方实现，按这些维度挑底座：任务与数据是否一致、是否官方或被广泛引用、许可证是否允许改造与发布、训练与评测脚本能否直接跑、是否已支持你要的规模、最近提交与 issue 活跃度。',
    '选 1 个主底座加 1 个备选，不要同时改三个仓库。记录不可变 commit。',
    '',
    '### 3. 对齐底座',
    '改造之前先让底座跑出接近论文报告的数字。跑不通就先解决环境；不要在一个还没跑通的代码上证明改进。',
    '',
    '### 4. 最小改造',
    '只加支撑 idea 所需的最小 diff。每个工程 trick 单独一个 config 开关、默认关闭——这是后面能写出「配料表」的前提：一个组件一个开关，才能一个一个加、一个一个测。',
    '',
    '### 5. 大规模调参',
    '用 research_sweep_plan 生成试验矩阵，搜索空间同时覆盖你的组件超参与底座敏感超参（lr、weight decay、warmup、batch、分辨率、序列长度）。',
    '先跑通 1 个 trial 再开大规模。每个 trial 独立落盘，中断可续。跑完一个就用 research_sweep_record 记账，包括失败和被剪枝的。',
    '',
    '### 6. 选优',
    '用 research_sweep_report 排名，看三件事：最好一组数字相对底座与靶子的差距；前几名之间的差距是否落进噪声；哪个参数的边际效应最大——那通常就是论文的主角。',
    '对前几名多种子重跑，报均值与波动，不要只报单次最好值。',
    '',
    '### 7. 配料表归因',
    '方法章节就是配料表。每个组件都要有加与不加的对比：完整模型、逐个去掉组件、组件累积叠加。这一节通常是审稿人最先看的。',
    '先看报告里的混杂检查：如果两个参数的取值在已测集合里一一对应，那它们的贡献根本分不开，必须拆开重测。',
    '',
    '### 8. 出材料',
    '从账本直接生成主结果表、最优配置表与消融表。报告里写清 trial 数量、搜索空间与选优依据——这是工程量证明，不是减分项。',
    '',
    '## 记账规则',
    '- 每个 trial 都记账，包括失败的：不知道搜索空间有多大，实验章节就撑不住。',
    '- 选优用 dev，最终数字用 test；如果两者是同一份，就在论文里说明。',
    '- 报告必须能回答「你试了多少组、怎么选的、为什么是这一组」。',
].join('\n');
//# sourceMappingURL=skill.js.map