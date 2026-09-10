import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/skill.js
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
const SKILL_DESCRIPTION = "把一句 fancy idea 推进成能写论文的实验章节：仓库选型与改造、大规模调参账本、选优排名、配料表归因与论文表格。";
/** Catalogue routing hint; decides whether the model loads this skill. */
const SKILL_WHEN_TO_USE = "当任务涉及复现基线、改造开源仓库、设计或运行超参搜索、对标 SOTA 数字、做消融实验、或准备论文的方法与实验章节时使用。";
/** The complete skill body loaded on demand. */
const SKILL_CONTENT = [
	"# Research Campaign — 从一句 idea 到能写论文的实验章节",
	"",
	"## 目标",
	"把一句 fancy idea 变成论文的实验章节：找到可改造的仓库、做出最小改造、大规模调参、选出最好的一组数字、把每个工程组件归因清楚。",
	"",
	"## 阶段",
	"",
	"### 1. 立靶",
	"先把要打败的数字钉死：benchmark 与版本、split、主指标与方向、当前最好值、报告来源，以及协议差异（模型规模、分辨率、训练数据、评测脚本）。",
	"用 research_sweep_plan 的 sota_* 字段把靶子写进账本，用 baseline_metrics 记录底座原始指标。没有靶子就不要开始调参。",
	"",
	"### 2. 选仓库",
	"搜 GitHub 与论文官方实现，按这些维度挑底座：任务与数据是否一致、是否官方或被广泛引用、许可证是否允许改造与发布、训练与评测脚本能否直接跑、是否已支持你要的规模、最近提交与 issue 活跃度。",
	"选 1 个主底座加 1 个备选，不要同时改三个仓库。记录不可变 commit。",
	"",
	"### 3. 对齐底座",
	"改造之前先让底座跑出接近论文报告的数字。跑不通就先解决环境；不要在一个还没跑通的代码上证明改进。",
	"",
	"### 4. 最小改造",
	"只加支撑 idea 所需的最小 diff。每个工程 trick 单独一个 config 开关、默认关闭——这是后面能写出「配料表」的前提：一个组件一个开关，才能一个一个加、一个一个测。",
	"",
	"### 5. 大规模调参",
	"用 research_sweep_plan 生成试验矩阵，搜索空间同时覆盖你的组件超参与底座敏感超参（lr、weight decay、warmup、batch、分辨率、序列长度）。",
	"先跑通 1 个 trial 再开大规模。每个 trial 独立落盘，中断可续。跑完一个就用 research_sweep_record 记账，包括失败和被剪枝的。",
	"",
	"### 6. 选优",
	"用 research_sweep_report 排名，看三件事：最好一组数字相对底座与靶子的差距；前几名之间的差距是否落进噪声；哪个参数的边际效应最大——那通常就是论文的主角。",
	"对前几名多种子重跑，报均值与波动，不要只报单次最好值。",
	"",
	"### 7. 配料表归因",
	"方法章节就是配料表。每个组件都要有加与不加的对比：完整模型、逐个去掉组件、组件累积叠加。这一节通常是审稿人最先看的。",
	"先看报告里的混杂检查：如果两个参数的取值在已测集合里一一对应，那它们的贡献根本分不开，必须拆开重测。",
	"",
	"### 8. 出材料",
	"从账本直接生成主结果表、最优配置表与消融表。报告里写清 trial 数量、搜索空间与选优依据——这是工程量证明，不是减分项。",
	"",
	"## 记账规则",
	"- 每个 trial 都记账，包括失败的：不知道搜索空间有多大，实验章节就撑不住。",
	"- 选优用 dev，最终数字用 test；如果两者是同一份，就在论文里说明。",
	"- 报告必须能回答「你试了多少组、怎么选的、为什么是这一组」。"
].join("\n");
//#endregion
//#region lib/types/sweep.js
/**
* The deterministic sweep engine behind the three research-campaign tools:
* search-space expansion, budget-bounded and de-confounded trial generation,
* ranking, per-parameter marginal effects, and the confounding check that
* decides whether a parameter's contribution is attributable at all.
*
* Every function here is pure and takes plain JSON, so the engine is testable
* without a Cordis context and the tools stay thin adapters over it.
*
* @module @deepseek-ai/dsh-tool-research-campaign/sweep
*/
/** Highest number of distinct configurations one sampling pass will attempt per requested trial. */
const SAMPLE_ATTEMPT_FACTOR = 200;
/** Extra sampling attempts so a small space still returns every distinct configuration it can. */
const SAMPLE_ATTEMPT_FLOOR = 1e3;
/** Significant digits kept for a generated numeric sweep value, so a range never emits float noise. */
const RANGE_PRECISION = 12;
/** Round a generated sweep bound without disturbing an integral value. */
function roundValue(value) {
	if (Number.isInteger(value)) return value;
	return Number(value.toPrecision(RANGE_PRECISION));
}
/**
* Render one statistic for a paper table. Configuration values keep full
* precision because they are real hyperparameters; statistics do not, because a
* mean printed to twelve digits is unreadable in a results table.
* @param value - the statistic to render.
* @returns the shortest exact-enough decimal string.
*/
function formatStat(value) {
	if (!Number.isFinite(value)) return String(value);
	if (Number.isInteger(value)) return String(value);
	const magnitude = Math.abs(value);
	if (magnitude >= 1e3) return String(Number(value.toPrecision(6)));
	if (magnitude >= 1) return String(Math.round(value * 1e4) / 1e4);
	if (magnitude >= .001) return String(Math.round(value * 1e6) / 1e6);
	return String(Number(value.toPrecision(3)));
}
/**
* Render one configuration value at full precision, so a table never shows a
* hyperparameter other than the one that ran.
* @param value - the value to render.
* @returns a display string.
*/
function formatConfigValue(value) {
	if (value === void 0 || value === null) return "--";
	if (typeof value === "number") return String(roundValue(value));
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}
/** Stable identity of one JSON value, used to group trials by parameter value. */
function valueKey(value) {
	return JSON.stringify(value === void 0 ? null : value);
}
/** Deterministic 32-bit linear-congruential generator; identical seeds give identical plans. */
function makeRng(seed) {
	let state = Math.floor(seed) >>> 0 || 1;
	return () => {
		state = state * 1664525 + 1013904223 >>> 0;
		return state / 4294967296;
	};
}
/** Whether a space entry is an explicit value list rather than a range specification. */
function isValueList(spec) {
	return Array.isArray(spec);
}
/** Whether a space entry is a range specification rather than an explicit value list. */
function isRangeSpec(spec) {
	return !Array.isArray(spec);
}
/**
* Expand one declared parameter into its candidate values.
* @param spec - an explicit value list, or `{min, max, steps, log?}`.
* @returns the expanded values, or null when the specification cannot produce any.
*/
function expandParameter(spec) {
	if (isValueList(spec)) return spec.length > 0 ? [...spec] : null;
	if (!isRangeSpec(spec)) return null;
	const { min, max, steps } = spec;
	if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
	if (!Number.isInteger(steps) || steps < 1) return null;
	if (steps === 1) return [min];
	const values = [];
	if (spec.log === true) {
		if (min <= 0 || max <= 0) return null;
		const low = Math.log(min);
		const high = Math.log(max);
		for (let index = 0; index < steps; index++) values.push(roundValue(Math.exp(low + (high - low) * index / (steps - 1))));
		return values;
	}
	for (let index = 0; index < steps; index++) values.push(roundValue(min + (max - min) * index / (steps - 1)));
	return values;
}
/** Merge base configuration with one trial's sampled parameter values. */
function mergeConfig(base, sampled) {
	return {
		...base,
		...sampled
	};
}
/** Stable identity of one complete configuration, used to reject duplicate samples. */
function configKey(config) {
	const parts = [];
	for (const name of Object.keys(config).sort()) parts.push(`${name}=${JSON.stringify(config[name])}`);
	return parts.join("|");
}
/**
* Sample distinct configurations uniformly from the declared per-parameter
* values. Uniform sampling, not a strided slice of the Cartesian product, is
* what keeps parameters independently attributable when the budget is smaller
* than the full grid: a fixed stride through a product correlates whichever
* dimensions the enumeration order put closest together.
* @param names - searched parameter names, in declaration order.
* @param values - expanded candidate values per parameter.
* @param count - how many distinct configurations to draw.
* @param seed - PRNG seed; the same seed reproduces the same plan.
* @returns up to `count` distinct configurations, fewer only if the space is smaller.
*/
function sampleDistinct(names, values, count, seed) {
	const rng = makeRng(seed);
	const seen = /* @__PURE__ */ new Set();
	const configs = [];
	const attemptLimit = count * SAMPLE_ATTEMPT_FACTOR + SAMPLE_ATTEMPT_FLOOR;
	for (let attempt = 0; attempt < attemptLimit && configs.length < count; attempt++) {
		const candidate = {};
		for (const name of names) {
			const list = values[name];
			if (list === void 0 || list.length === 0) continue;
			const picked = list[Math.floor(rng() * list.length)];
			if (picked !== void 0) candidate[name] = picked;
		}
		const key = configKey(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		configs.push(candidate);
	}
	return configs;
}
/** Enumerate the complete Cartesian product of the declared parameter values. */
function fullGrid(names, values) {
	let combos = [{}];
	for (const name of names) {
		const list = values[name] ?? [];
		const next = [];
		for (const combo of combos) for (const value of list) next.push({
			...combo,
			[name]: value
		});
		combos = next;
	}
	return combos;
}
/**
* Roughly how evenly each parameter's values are represented across a trial set.
* @param names - searched parameter names.
* @param values - expanded candidate values per parameter.
* @param trials - the trials to inspect.
* @returns per-parameter counts keyed by the JSON identity of each value.
*/
function parameterCoverage(names, values, trials) {
	return names.map((name) => {
		const counts = {};
		for (const value of values[name] ?? []) counts[valueKey(value)] = 0;
		for (const trial of trials) {
			const key = valueKey(trial.config[name]);
			counts[key] = (counts[key] ?? 0) + 1;
		}
		return {
			name,
			counts
		};
	});
}
/**
* Find parameters whose values never vary independently across a trial set.
* Such a pair is a bijection: every value of one occurs with exactly one value
* of the other, so no experiment in the set separates their contributions and
* any ablation claim covering both is unsupported.
* @param names - searched parameter names.
* @param trials - the trials to inspect; already-completed trials give the honest answer.
* @returns every confounded pair, in declaration order.
*/
function findConfoundedPairs(names, trials) {
	const active = names.filter((name) => {
		const distinct = /* @__PURE__ */ new Set();
		for (const trial of trials) distinct.add(valueKey(trial.config[name]));
		return distinct.size >= 2;
	});
	const pairs = [];
	for (let a = 0; a < active.length; a++) for (let b = a + 1; b < active.length; b++) {
		const first = active[a];
		const second = active[b];
		if (first === void 0 || second === void 0) continue;
		const forward = /* @__PURE__ */ new Map();
		const backward = /* @__PURE__ */ new Map();
		let bijection = true;
		for (const trial of trials) {
			const keyA = valueKey(trial.config[first]);
			const keyB = valueKey(trial.config[second]);
			const seenB = forward.get(keyA);
			if (seenB === void 0) forward.set(keyA, keyB);
			else if (seenB !== keyB) bijection = false;
			const seenA = backward.get(keyB);
			if (seenA === void 0) backward.set(keyB, keyA);
			else if (seenA !== keyA) bijection = false;
		}
		if (bijection) pairs.push({
			a: first,
			b: second
		});
	}
	return pairs;
}
/**
* Expand one search space into a bounded trial matrix and audit it for the two
* design faults that make a published ablation unsupportable: a parameter value
* no trial exercises, and a pair of parameters the plan cannot separate.
* @param request - the space, base configuration, budget, strategy, and seed.
* @returns the plan plus its coverage and confounding audit.
*/
function planSweep(request) {
	const names = Object.keys(request.space);
	const values = {};
	const invalid = [];
	for (const name of names) {
		const spec = request.space[name];
		if (spec === void 0) {
			invalid.push(`${name}: missing specification`);
			continue;
		}
		const expanded = expandParameter(spec);
		if (expanded === null) {
			invalid.push(`${name}: expected a non-empty value array or {min, max, steps, log?}`);
			continue;
		}
		values[name] = expanded;
	}
	const usable = names.filter((name) => values[name] !== void 0);
	let totalCombinations = 1;
	for (const name of usable) totalCombinations *= values[name]?.length ?? 0;
	const completeGridFits = request.strategy === "grid" && totalCombinations <= request.maxTrials;
	const sampled = !completeGridFits;
	const trials = (completeGridFits ? fullGrid(usable, values) : sampleDistinct(usable, values, request.maxTrials, request.seed)).map((sampledConfig, index) => ({
		id: `t${String(index + 1).padStart(4, "0")}`,
		config: mergeConfig(request.baseConfig, sampledConfig)
	}));
	const untestedValues = parameterCoverage(usable, values, trials).filter((entry) => Object.values(entry.counts).some((count) => count === 0)).map((entry) => entry.name);
	return {
		trials,
		values,
		totalCombinations,
		sampled,
		strategy: request.strategy,
		untestedValues,
		confounded: findConfoundedPairs(usable, trials),
		invalid
	};
}
/**
* Rank completed trials by one metric.
* @param trials - candidate trials; those without a numeric value for the metric are skipped.
* @param metric - the metric name to rank by.
* @param direction - `max` puts the largest value first, `min` the smallest.
* @returns ranked entries, best first.
*/
function rankTrials(trials, metric, direction) {
	const scored = [];
	for (const trial of trials) {
		if (trial.status !== "ok" || trial.metrics === null) continue;
		const value = trial.metrics[metric];
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		scored.push({
			trial,
			value
		});
	}
	scored.sort((left, right) => direction === "max" ? right.value - left.value : left.value - right.value);
	return scored;
}
/**
* Aggregate the ranking metric per value of one parameter, so the report can
* state which searched component moved the number and by how much.
* @param scored - ranked trials from {@link rankTrials}.
* @param parameter - the parameter to aggregate.
* @param direction - ordering of the returned rows, best mean first.
* @returns one row per observed value, ordered best first.
*/
function marginalEffect(scored, parameter, direction) {
	const groups = /* @__PURE__ */ new Map();
	for (const entry of scored) {
		const value = entry.trial.config[parameter] ?? null;
		const key = valueKey(value ?? void 0);
		const group = groups.get(key);
		if (group === void 0) groups.set(key, {
			value,
			sum: entry.value,
			count: 1
		});
		else {
			group.sum += entry.value;
			group.count++;
		}
	}
	const rows = [...groups.values()].map((group) => ({
		value: group.value,
		mean: group.sum / group.count,
		count: group.count
	}));
	rows.sort((left, right) => direction === "max" ? right.mean - left.mean : left.mean - right.mean);
	return rows;
}
//#endregion
//#region lib/types/index.js
/**
* Model-facing research-campaign tools plus the campaign playbook skill: open a
* bounded tuning ledger, record every finished trial, and rank the result into
* the tables a paper's experiments section needs.
*
* The ledger is process state owned by this plugin's fiber and keyed by the
* calling agent, so two sessions never see each other's campaigns and a
* reloaded process starts empty. The durable record of a long campaign is the
* caller's own run log; this package's contract is the trial matrix and its
* statistics, not storage.
*
* Named exports preserve loader injection metadata.
*
* @module @deepseek-ai/dsh-tool-research-campaign
*/
const name = "tool-research-campaign";
const inject = ["tools", "skills"];
/** Curated name of the skill this package contributes to the session catalogue. */
const RESEARCH_CAMPAIGN_SKILL = "research-campaign";
/** Ordered parameter columns a report prints before it elides the remainder. */
const REPORT_PARAMETER_COLUMNS = 6;
/** Rows a report prints when the caller names no limit. */
const DEFAULT_REPORT_ROWS = 10;
/** The three lifecycle states a record call may set. */
const RECORDABLE_STATUSES = [
	"running",
	"ok",
	"failed",
	"pruned"
];
/** Schemastery configuration for the research-campaign consumer. */
const Config = z.object({ maxTrialsPerCampaign: z.number().required() });
/** Whether a JSON value is a plain object rather than an array or a scalar. */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Validate the model-supplied search space at the tool boundary. The model
* writes plain JSON, so every shape rule is enforced here rather than trusted.
* @param value - the raw `space` argument.
* @returns the validated search space.
*/
function parseSearchSpace(value) {
	if (!isPlainObject(value)) throw new Error("space must be a JSON object mapping parameter name to values or a range spec");
	const space = {};
	for (const [parameter, spec] of Object.entries(value)) {
		if (Array.isArray(spec)) {
			space[parameter] = spec;
			continue;
		}
		if (!isPlainObject(spec)) throw new Error(`space.${parameter} must be a value array or {min, max, steps, log?}`);
		space[parameter] = spec;
	}
	if (Object.keys(space).length === 0) throw new Error("space must declare at least one parameter");
	return space;
}
/**
* Validate an optional plain-object argument that maps names to JSON values.
* @param value - the raw argument, absent when the model omitted it.
* @param label - the argument name used in the failure message.
* @returns the object, or an empty record when the argument is absent.
*/
function parseRecord(value, label) {
	if (value === void 0) return {};
	if (!isPlainObject(value)) throw new Error(`${label} must be a JSON object`);
	return value;
}
/**
* Validate an optional metric map. Metrics are the numbers a paper reports, so
* a non-numeric entry fails loud instead of being dropped from the ranking.
* @param value - the raw `metrics` argument.
* @returns validated metric names to finite numbers.
*/
function parseMetrics(value) {
	const raw = parseRecord(value, "metrics");
	const metrics = {};
	for (const [metric, entry] of Object.entries(raw)) {
		if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`metrics.${metric} must be a finite number`);
		metrics[metric] = entry;
	}
	return metrics;
}
/** Read one campaign for a calling agent, failing loud when the id is unknown. */
function requireCampaign(ledgers, owner, id) {
	const campaign = ledgers.get(owner)?.get(id);
	if (campaign === void 0) {
		const known = [...ledgers.get(owner)?.keys() ?? []];
		throw new Error(`unknown campaign ${JSON.stringify(id)} for this session; known: ${known.length === 0 ? "none" : known.join(", ")}`);
	}
	return campaign;
}
/** Render the ranked table plus every row a reader needs to trust the ranking. */
function renderReport(campaign, metric, direction, topK) {
	const counts = {
		running: 0,
		ok: 0,
		failed: 0,
		pruned: 0
	};
	for (const trial of campaign.trials) counts[trial.status]++;
	const scored = rankTrials(campaign.trials, metric, direction);
	const parameters = Object.keys(campaign.values);
	const out = [];
	out.push(`# Sweep report: ${campaign.id}`);
	out.push("");
	out.push(`Metric: ${metric} (${direction === "max" ? "maximize" : "minimize"})`);
	out.push(`Trials: ${counts.ok} ok, ${counts.failed} failed, ${counts.pruned} pruned, ${counts.running} running, out of ${campaign.trials.length} planned over ${campaign.totalCombinations} combinations`);
	out.push("");
	if (scored.length === 0) {
		out.push(`No trial has a numeric ${metric} yet. Record finished runs with research_sweep_record before ranking.`);
		return out.join("\n");
	}
	const baselineValue = campaign.baseline[metric];
	const sotaValue = campaign.sota?.metric === metric ? campaign.sota.value : void 0;
	const delta = (value, reference) => {
		if (reference === void 0) return "--";
		const change = value - reference;
		const improved = direction === "max" ? change > 0 : change < 0;
		return `${change > 0 ? "+" : ""}${formatStat(change)}${improved ? " WIN" : ""}`;
	};
	const columns = parameters.slice(0, REPORT_PARAMETER_COLUMNS);
	out.push("## Ranking");
	out.push("");
	out.push(`| # | trial | ${metric} | vs baseline | vs SOTA | ${columns.join(" | ")} |`);
	out.push(`| ${[
		"---",
		"---",
		"---",
		"---",
		"---",
		...columns.map(() => "---")
	].join(" | ")} |`);
	const shown = scored.slice(0, topK);
	shown.forEach((entry, index) => {
		const cells = columns.map((parameter) => formatConfigValue(entry.trial.config[parameter]));
		out.push(`| ${index + 1} | ${entry.trial.id} | ${formatStat(entry.value)} | ${delta(entry.value, baselineValue)} | ${delta(entry.value, sotaValue)} | ${cells.join(" | ")} |`);
	});
	if (columns.length < parameters.length) {
		out.push("");
		out.push(`(${parameters.length - columns.length} more parameters are in the ledger but omitted from this table.)`);
	}
	out.push("");
	const best = shown[0];
	if (best === void 0) return out.join("\n");
	out.push("## Best configuration");
	out.push("");
	out.push("```json");
	out.push(JSON.stringify(best.trial.config));
	out.push("```");
	out.push("");
	out.push(`Best ${metric}: ${formatStat(best.value)} at trial ${best.trial.id}.`);
	out.push("");
	out.push("## Reference points");
	out.push("");
	out.push(`- baseline: ${baselineValue === void 0 ? `not recorded for ${metric}` : formatStat(baselineValue)}`);
	out.push(`- sota target: ${sotaValue === void 0 || campaign.sota === null ? `not recorded for ${metric}` : `${formatStat(sotaValue)}${campaign.sota.source === "" ? "" : ` (${campaign.sota.source})`}`}`);
	if (baselineValue !== void 0) {
		const gain = best.value - baselineValue;
		const relative = baselineValue === 0 ? "n/a" : `${formatStat(gain / Math.abs(baselineValue) * 100)}%`;
		out.push(`- best over baseline: ${gain > 0 ? "+" : ""}${formatStat(gain)} (${relative})`);
	}
	if (sotaValue !== void 0) {
		const margin = direction === "max" ? best.value - sotaValue : sotaValue - best.value;
		out.push(`- best over sota target: ${margin > 0 ? "+" : ""}${formatStat(margin)}${margin > 0 ? " (target beaten)" : " (target NOT beaten)"}`);
	}
	out.push("");
	const runnerUp = scored[1];
	if (runnerUp !== void 0) {
		out.push("## Noise check");
		out.push("");
		out.push(`- gap between rank 1 and rank 2: ${formatStat(Math.abs(best.value - runnerUp.value))}`);
		const third = scored[2];
		if (third !== void 0) out.push(`- gap between rank 1 and rank 3: ${formatStat(Math.abs(best.value - third.value))}`);
		out.push("- if these gaps are smaller than your seed-to-seed variation, the ranking is noise: rerun the top configurations with several seeds before choosing.");
		out.push("");
	}
	const confounded = findConfoundedPairs(parameters, scored.map((entry) => entry.trial));
	out.push("## Confounding check");
	out.push("");
	if (confounded.length === 0) out.push("No pair of tested parameters is perfectly correlated, so each parameter has independent evidence.");
	else for (const pair of confounded) out.push(`- ${pair.a} and ${pair.b} always share the same value pairing in the completed trials, so their separate contributions cannot be claimed. Add trials that vary them independently.`);
	out.push("");
	out.push("## Marginal effect by parameter");
	out.push("");
	for (const parameter of parameters) {
		out.push(`### ${parameter}`);
		out.push("");
		out.push(`| value | mean ${metric} | trials |`);
		out.push("| --- | --- | --- |");
		for (const row of marginalEffect(scored, parameter, direction)) out.push(`| ${formatConfigValue(row.value ?? void 0)} | ${formatStat(row.mean)} | ${row.count} |`);
		out.push("");
	}
	const distinctValues = (parameter) => new Set(scored.map((entry) => JSON.stringify(entry.trial.config[parameter] ?? null))).size;
	const checklist = [
		[baselineValue !== void 0, `baseline recorded for ${metric}`],
		[sotaValue !== void 0, `SOTA target and source recorded for ${metric}`],
		[counts.ok >= 3, "at least 3 completed trials"],
		[counts.failed + counts.pruned > 0, "failed or pruned runs also recorded"],
		[parameters.every((parameter) => distinctValues(parameter) >= 2), "every searched parameter has at least 2 tested values"],
		[confounded.length === 0, "no parameter pair is confounded"]
	];
	out.push("## Paper materials checklist");
	out.push("");
	for (const [met, label] of checklist) out.push(`- [${met ? "x" : " "}] ${label}`);
	out.push("");
	out.push("An unchecked line is a missing item for the methods or experiments section of the paper.");
	return out.join("\n");
}
/**
* Register the research-campaign skill and its three sweep tools on `ctx`.
* @param ctx - registrant context carrying the tool and skill registries.
* @param config - the deployment's explicit trial ceiling.
*/
function apply(ctx, config) {
	const maxTrialsPerCampaign = config.maxTrialsPerCampaign;
	if (!Number.isInteger(maxTrialsPerCampaign) || maxTrialsPerCampaign < 1) throw new Error("maxTrialsPerCampaign must be a positive integer");
	const ledgers = /* @__PURE__ */ new Map();
	ctx.skills.register({
		name: RESEARCH_CAMPAIGN_SKILL,
		description: SKILL_DESCRIPTION,
		whenToUse: SKILL_WHEN_TO_USE,
		source: "runtime",
		content: SKILL_CONTENT
	});
	ctx.tools.register(defineTool({
		name: "research_sweep_plan",
		description: "Open a tuning ledger and expand a search space into a bounded, de-confounded trial matrix. When the full grid exceeds the budget it samples uniformly instead of truncating, and reports per-value coverage and any parameter pair the plan cannot separate.",
		parameters: {
			campaign: {
				type: "string",
				required: true,
				description: "Ledger id, for example resnet-lr-sweep. Must be new."
			},
			space: {
				type: "json",
				required: true,
				description: "Parameter name to either an explicit value array or a range spec {min, max, steps, log?}. Every searched parameter belongs here."
			},
			max_trials: {
				type: "integer",
				required: true,
				description: "Hard cap on generated trials."
			},
			base_config: {
				type: "json",
				description: "Configuration merged into every trial, for example unchanged backbone and dataset settings."
			},
			strategy: {
				type: "string",
				enum: ["grid", "random"],
				description: "grid expands the full Cartesian product when it fits the budget; random samples distinct configurations with a seeded PRNG. Default grid."
			},
			seed: {
				type: "integer",
				description: "Seed for sampling. Default 1."
			},
			baseline_metrics: {
				type: "json",
				description: "Metrics of the unmodified baseline repository, keyed by metric name."
			},
			sota_metric: {
				type: "string",
				description: "Metric name the SOTA target is reported on."
			},
			sota_value: {
				type: "number",
				description: "Current best reported value for that metric."
			},
			sota_source: {
				type: "string",
				description: "Where that number comes from: paper, table, URL, or leaderboard entry."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute(args, exec) {
			const owner = exec.agent;
			if (owner === void 0) throw new Error("research_sweep_plan requires an owning agent session");
			const id = args.campaign.trim();
			if (id === "") throw new Error("campaign must be a non-empty id");
			const ledger = ledgers.get(owner.id) ?? /* @__PURE__ */ new Map();
			ledgers.set(owner.id, ledger);
			if (ledger.has(id)) throw new Error(`campaign ${JSON.stringify(id)} already exists; pick a new id rather than reusing a ledger with recorded results`);
			if (args.max_trials > maxTrialsPerCampaign) throw new Error(`max_trials ${args.max_trials} exceeds this deployment's ceiling of ${maxTrialsPerCampaign}`);
			const strategy = args.strategy ?? "grid";
			const plan = planSweep({
				space: parseSearchSpace(args.space),
				baseConfig: parseRecord(args.base_config, "base_config"),
				strategy,
				maxTrials: args.max_trials,
				seed: args.seed ?? 1
			});
			if (plan.invalid.length > 0) throw new Error(`invalid search space: ${plan.invalid.join("; ")}`);
			const baseline = parseMetrics(args.baseline_metrics);
			const sota = args.sota_metric !== void 0 && args.sota_metric.trim() !== "" && args.sota_value !== void 0 ? {
				metric: args.sota_metric.trim(),
				value: args.sota_value,
				source: args.sota_source?.trim() ?? ""
			} : null;
			const trials = plan.trials.map((trial) => ({
				id: trial.id,
				config: trial.config,
				status: "running",
				metrics: null,
				notes: ""
			}));
			ledger.set(id, {
				id,
				values: plan.values,
				trials,
				baseline,
				sota,
				strategy,
				sampled: plan.sampled,
				totalCombinations: plan.totalCombinations
			});
			const out = [];
			out.push(`# Sweep ledger opened: ${id}`);
			out.push("");
			out.push(`Full grid size: ${plan.totalCombinations} combinations`);
			out.push(`Trials generated: ${trials.length} using ${plan.sampled ? `seeded uniform sampling (seed ${args.seed ?? 1})` : "a complete Cartesian grid"}`);
			if (plan.sampled && strategy === "grid") {
				out.push("");
				out.push("The full grid exceeded max_trials, so trials were sampled uniformly rather than truncated by stride. A stride slice of a Cartesian product correlates the parameters and destroys ablation attribution.");
			}
			out.push("");
			out.push("Search space:");
			for (const [parameter, values] of Object.entries(plan.values)) {
				const preview = values.length <= 8 ? values.map((value) => formatConfigValue(value)).join(", ") : `${values.slice(0, 8).map((value) => formatConfigValue(value)).join(", ")}, ...`;
				out.push(`- ${parameter} (${values.length} values): ${preview}`);
			}
			out.push("");
			out.push("Reference points:");
			out.push(`- baseline: ${Object.keys(baseline).length === 0 ? "not recorded" : JSON.stringify(baseline)}`);
			out.push(`- sota target: ${sota === null ? "not recorded (record one before claiming SOTA)" : `${sota.metric} = ${sota.value}${sota.source === "" ? "" : ` (${sota.source})`}`}`);
			out.push("");
			out.push("Design checks:");
			out.push(plan.untestedValues.length === 0 ? "- coverage: every value of every parameter is tested at least once" : `- coverage warning: some values are never tested in ${plan.untestedValues.join(", ")}`);
			out.push(plan.confounded.length === 0 ? "- confounding: no parameter pair is perfectly correlated in this plan" : plan.confounded.map((pair) => `- confounding warning: ${pair.a} and ${pair.b} move together in every trial, so their individual contributions cannot be attributed. Add trials that vary them independently.`).join("\n"));
			out.push("");
			out.push("Trials:");
			for (const trial of trials.slice(0, 20)) out.push(`- ${trial.id}: ${JSON.stringify(trial.config)}`);
			if (trials.length > 20) out.push(`- ... and ${trials.length - 20} more`);
			out.push("");
			out.push(`Next: run the pipeline on trial ${trials[0]?.id ?? "(none)"} first, then report every finished trial with research_sweep_record.`);
			return Promise.resolve(out.join("\n"));
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Plan tuning sweep",
			kind: "other",
			rawInput: args.campaign
		})
	}));
	ctx.tools.register(defineTool({
		name: "research_sweep_record",
		description: "Record one finished trial into the tuning ledger, including failed and pruned runs, so the ledger states how large the search actually was.",
		parameters: {
			campaign: {
				type: "string",
				required: true,
				description: "Ledger id created by research_sweep_plan."
			},
			trial_id: {
				type: "string",
				required: true,
				description: "Trial id such as t0007."
			},
			status: {
				type: "string",
				required: true,
				enum: [
					"running",
					"ok",
					"failed",
					"pruned"
				],
				description: "ok for a completed run with metrics; failed for a crash; pruned for early stopping."
			},
			metrics: {
				type: "json",
				description: "Metric name to value for this trial, for example {\"accuracy\": 72.4}."
			},
			notes: {
				type: "string",
				description: "Short note: error, decision, or config deviation worth keeping."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute(args, exec) {
			const owner = exec.agent;
			if (owner === void 0) throw new Error("research_sweep_record requires an owning agent session");
			const campaign = requireCampaign(ledgers, owner.id, args.campaign.trim());
			const trial = campaign.trials.find((candidate) => candidate.id === args.trial_id.trim());
			if (trial === void 0) throw new Error(`unknown trial ${JSON.stringify(args.trial_id)} in campaign ${campaign.id}`);
			const metrics = parseMetrics(args.metrics);
			if (args.status === "ok" && Object.keys(metrics).length === 0) throw new Error("status ok requires at least one metric; use failed or pruned when the run produced no numbers");
			if (!RECORDABLE_STATUSES.includes(args.status)) throw new Error(`status must be one of ${RECORDABLE_STATUSES.join(", ")}`);
			trial.status = args.status;
			if (Object.keys(metrics).length > 0) trial.metrics = metrics;
			trial.notes = args.notes ?? "";
			const counts = {
				running: 0,
				ok: 0,
				failed: 0,
				pruned: 0
			};
			for (const entry of campaign.trials) counts[entry.status]++;
			const out = [`Recorded ${trial.id} as ${trial.status}${Object.keys(metrics).length > 0 ? ` ${JSON.stringify(metrics)}` : ""}.`, `Progress: ${counts.ok} ok, ${counts.failed} failed, ${counts.pruned} pruned, ${counts.running} running, out of ${campaign.trials.length} planned.`];
			if (trial.notes !== "") out.push(`Note: ${trial.notes}`);
			return Promise.resolve(out.join("\n"));
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Record trial ${args.trial_id}`,
			kind: "other",
			rawInput: args.campaign
		})
	}));
	ctx.tools.register(defineTool({
		name: "research_sweep_report",
		description: "Rank a tuning ledger by one metric, show the best configuration, the margin against baseline and SOTA target, the marginal effect of every searched parameter, and flag confounded parameter pairs. This is the scoreboard for picking the numbers that go in the paper.",
		parameters: {
			campaign: {
				type: "string",
				required: true,
				description: "Ledger id created by research_sweep_plan."
			},
			metric: {
				type: "string",
				required: true,
				description: "Metric name to rank by, exactly as it was recorded."
			},
			direction: {
				type: "string",
				enum: ["max", "min"],
				description: "max for accuracy-like metrics, min for loss-like metrics. Default max."
			},
			top_k: {
				type: "integer",
				description: "How many ranked trials to show. Default 10."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute(args, exec) {
			const owner = exec.agent;
			if (owner === void 0) throw new Error("research_sweep_report requires an owning agent session");
			const campaign = requireCampaign(ledgers, owner.id, args.campaign.trim());
			const metric = args.metric.trim();
			if (metric === "") throw new Error("metric must be a non-empty name");
			const topK = args.top_k ?? DEFAULT_REPORT_ROWS;
			if (!Number.isInteger(topK) || topK < 1) throw new Error("top_k must be a positive integer");
			return Promise.resolve(renderReport(campaign, metric, args.direction ?? "max", topK));
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Sweep report by ${args.metric}`,
			kind: "other",
			rawInput: args.campaign
		})
	}));
}
//#endregion
export { Config, RESEARCH_CAMPAIGN_SKILL, apply, inject, name };
