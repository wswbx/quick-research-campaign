/**
 * Pure types of the research-campaign domain: the search space a caller
 * declares, the trial matrix those declarations expand into, and the campaign
 * record the three model-facing tools share. Free of this package's host-side
 * value imports so a test or a future consumer can hold the vocabulary without
 * pulling in the tool registry.
 *
 * Nothing here is durable or session-logged: the ledger is process state owned
 * by one mounted plugin fiber, keyed per calling agent.
 *
 * @module @deepseek-ai/dsh-tool-research-campaign/types
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
/** How an over-budget search space is covered. */
export type SweepStrategy = 'grid' | 'random';
/** Whether a metric improves by growing or by shrinking. */
export type MetricDirection = 'max' | 'min';
/** Lifecycle of one planned trial inside a campaign ledger. */
export type TrialStatus = 'running' | 'ok' | 'failed' | 'pruned';
/** An inclusive numeric sweep expanded into `steps` evenly spaced values. */
export interface RangeSpec {
    /** Lowest value; the first generated value when `log` is false. */
    readonly min: number;
    /** Highest value; the last generated value. */
    readonly max: number;
    /** How many values to generate; at least 1. */
    readonly steps: number;
    /** Generate a geometric rather than arithmetic progression; both bounds must be positive. */
    readonly log?: boolean;
}
/** The values one searched parameter may take. */
export type ParameterValues = readonly JsonValue[];
/**
 * Map of searched parameter name to its values or its range specification.
 * Every parameter the campaign searches belongs here, and the declared keys are
 * the only parameters whose marginal effect the report can attribute.
 */
export type SearchSpace = Readonly<Record<string, ParameterValues | RangeSpec>>;
/**
 * The published number a campaign tries to beat, with its provenance. A
 * campaign without one still ranks trials, but reports no SOTA margin.
 */
export interface SotaTarget {
    /** Metric name this value is reported on; must match a recorded metric to be used. */
    readonly metric: string;
    /** The reported best value at the time the campaign opened. */
    readonly value: number;
    /** Where the number comes from: paper, table, URL, or leaderboard entry. */
    readonly source: string;
}
/** One planned configuration and its recorded outcome. */
export interface SweepTrial {
    /** Stable identifier within the campaign, for example `t0007`. */
    readonly id: string;
    /** Base configuration merged with this trial's sampled parameter values. */
    readonly config: Readonly<Record<string, JsonValue>>;
    /** Current lifecycle state; `running` until a record call settles it. */
    status: TrialStatus;
    /** Recorded metrics, or null while the trial has produced no numbers. */
    metrics: Readonly<Record<string, number>> | null;
    /** Caller-supplied note: an error, a decision, or a configuration deviation. */
    notes: string;
}
/**
 * One opened tuning ledger. Trials are mutable in place — a campaign is a
 * long-running record that settles one trial at a time — while the campaign's
 * structure (its space, its reference points) is fixed at plan time.
 */
export interface SweepCampaign {
    /** Ledger identifier chosen by the caller. */
    readonly id: string;
    /** Expanded candidate values per searched parameter, in declaration order. */
    readonly values: Readonly<Record<string, readonly JsonValue[]>>;
    /** Every planned trial, in generation order. */
    readonly trials: SweepTrial[];
    /** Metrics of the unmodified baseline repository, keyed by metric name. */
    readonly baseline: Readonly<Record<string, number>>;
    /** The published target this campaign measures against, or null when none was given. */
    readonly sota: SotaTarget | null;
    /** Strategy actually used: a complete grid, or seeded sampling when the grid exceeded the budget. */
    readonly strategy: SweepStrategy;
    /** Whether trials were sampled rather than enumerated from a complete grid. */
    readonly sampled: boolean;
    /** Size of the complete Cartesian product before any budget cap. */
    readonly totalCombinations: number;
}
/** A pair of parameters whose values never vary independently in a trial set. */
export interface ConfoundedPair {
    /** First parameter of the pair. */
    readonly a: string;
    /** Second parameter of the pair. */
    readonly b: string;
}
/** One ranked trial and the metric value it is ranked by. */
export interface ScoredTrial {
    /** The ranked trial. */
    readonly trial: SweepTrial;
    /** Its value for the ranking metric. */
    readonly value: number;
}
/** Aggregate metric for one value of one parameter across the ranked trials. */
export interface MarginalRow {
    /** The parameter value, or null when a trial carried no value for that parameter. */
    readonly value: JsonValue | null;
    /** Mean ranking metric across trials holding this value. */
    readonly mean: number;
    /** How many ranked trials held this value. */
    readonly count: number;
}
//# sourceMappingURL=types.d.ts.map