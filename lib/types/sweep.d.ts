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
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ConfoundedPair, MarginalRow, MetricDirection, ParameterValues, RangeSpec, ScoredTrial, SearchSpace, SweepStrategy, SweepTrial } from './types.ts';
/**
 * Render one statistic for a paper table. Configuration values keep full
 * precision because they are real hyperparameters; statistics do not, because a
 * mean printed to twelve digits is unreadable in a results table.
 * @param value - the statistic to render.
 * @returns the shortest exact-enough decimal string.
 */
export declare function formatStat(value: number): string;
/**
 * Render one configuration value at full precision, so a table never shows a
 * hyperparameter other than the one that ran.
 * @param value - the value to render.
 * @returns a display string.
 */
export declare function formatConfigValue(value: JsonValue | undefined): string;
/**
 * Expand one declared parameter into its candidate values.
 * @param spec - an explicit value list, or `{min, max, steps, log?}`.
 * @returns the expanded values, or null when the specification cannot produce any.
 */
export declare function expandParameter(spec: ParameterValues | RangeSpec): JsonValue[] | null;
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
export declare function sampleDistinct(names: readonly string[], values: Readonly<Record<string, readonly JsonValue[]>>, count: number, seed: number): Array<Record<string, JsonValue>>;
/**
 * Roughly how evenly each parameter's values are represented across a trial set.
 * @param names - searched parameter names.
 * @param values - expanded candidate values per parameter.
 * @param trials - the trials to inspect.
 * @returns per-parameter counts keyed by the JSON identity of each value.
 */
export declare function parameterCoverage(names: readonly string[], values: Readonly<Record<string, readonly JsonValue[]>>, trials: readonly {
    readonly config: Readonly<Record<string, JsonValue>>;
}[]): Array<{
    readonly name: string;
    readonly counts: Readonly<Record<string, number>>;
}>;
/**
 * Find parameters whose values never vary independently across a trial set.
 * Such a pair is a bijection: every value of one occurs with exactly one value
 * of the other, so no experiment in the set separates their contributions and
 * any ablation claim covering both is unsupported.
 * @param names - searched parameter names.
 * @param trials - the trials to inspect; already-completed trials give the honest answer.
 * @returns every confounded pair, in declaration order.
 */
export declare function findConfoundedPairs(names: readonly string[], trials: readonly {
    readonly config: Readonly<Record<string, JsonValue>>;
}[]): ConfoundedPair[];
/** One planned trial before it becomes a campaign record. */
export interface PlannedTrialConfig {
    /** Stable identifier within the campaign. */
    readonly id: string;
    /** Base configuration merged with the sampled parameter values. */
    readonly config: Record<string, JsonValue>;
}
/** Result of expanding one search space under a trial budget. */
export interface PlanOutcome {
    /** The generated trials, in generation order. */
    readonly trials: readonly PlannedTrialConfig[];
    /** Expanded candidate values per searched parameter. */
    readonly values: Readonly<Record<string, readonly JsonValue[]>>;
    /** Size of the complete Cartesian product before the budget cap. */
    readonly totalCombinations: number;
    /** Whether sampling was used instead of a complete grid. */
    readonly sampled: boolean;
    /** Strategy actually applied. */
    readonly strategy: SweepStrategy;
    /** Parameter names carrying a value that no generated trial exercises. */
    readonly untestedValues: readonly string[];
    /** Parameter pairs that the generated plan cannot separate. */
    readonly confounded: readonly ConfoundedPair[];
    /** Search-space entries that could not be expanded, with the reason. */
    readonly invalid: readonly string[];
}
/**
 * Expand one search space into a bounded trial matrix and audit it for the two
 * design faults that make a published ablation unsupportable: a parameter value
 * no trial exercises, and a pair of parameters the plan cannot separate.
 * @param request - the space, base configuration, budget, strategy, and seed.
 * @returns the plan plus its coverage and confounding audit.
 */
export declare function planSweep(request: {
    readonly space: SearchSpace;
    readonly baseConfig: Readonly<Record<string, JsonValue>>;
    readonly strategy: SweepStrategy;
    readonly maxTrials: number;
    readonly seed: number;
}): PlanOutcome;
/**
 * Rank completed trials by one metric.
 * @param trials - candidate trials; those without a numeric value for the metric are skipped.
 * @param metric - the metric name to rank by.
 * @param direction - `max` puts the largest value first, `min` the smallest.
 * @returns ranked entries, best first.
 */
export declare function rankTrials(trials: readonly SweepTrial[], metric: string, direction: MetricDirection): ScoredTrial[];
/**
 * Aggregate the ranking metric per value of one parameter, so the report can
 * state which searched component moved the number and by how much.
 * @param scored - ranked trials from {@link rankTrials}.
 * @param parameter - the parameter to aggregate.
 * @param direction - ordering of the returned rows, best mean first.
 * @returns one row per observed value, ordered best first.
 */
export declare function marginalEffect(scored: readonly ScoredTrial[], parameter: string, direction: MetricDirection): MarginalRow[];
/**
 * Build the per-trial ranking table rows the report renders.
 * @param scored - ranked trials.
 * @param parameters - parameter columns to include, in order.
 * @param limit - maximum number of rows to return.
 * @returns the parameter values of each shown trial, aligned with `parameters`.
 */
export declare function rankingRows(scored: readonly ScoredTrial[], parameters: readonly string[], limit: number): Array<{
    readonly id: string;
    readonly value: number;
    readonly cells: readonly string[];
}>;
//# sourceMappingURL=sweep.d.ts.map