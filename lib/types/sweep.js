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
const SAMPLE_ATTEMPT_FLOOR = 1000;
/** Significant digits kept for a generated numeric sweep value, so a range never emits float noise. */
const RANGE_PRECISION = 12;
/** Round a generated sweep bound without disturbing an integral value. */
function roundValue(value) {
    if (Number.isInteger(value))
        return value;
    return Number(value.toPrecision(RANGE_PRECISION));
}
/**
 * Render one statistic for a paper table. Configuration values keep full
 * precision because they are real hyperparameters; statistics do not, because a
 * mean printed to twelve digits is unreadable in a results table.
 * @param value - the statistic to render.
 * @returns the shortest exact-enough decimal string.
 */
export function formatStat(value) {
    if (!Number.isFinite(value))
        return String(value);
    if (Number.isInteger(value))
        return String(value);
    const magnitude = Math.abs(value);
    if (magnitude >= 1000)
        return String(Number(value.toPrecision(6)));
    if (magnitude >= 1)
        return String(Math.round(value * 10000) / 10000);
    if (magnitude >= 0.001)
        return String(Math.round(value * 1000000) / 1000000);
    return String(Number(value.toPrecision(3)));
}
/**
 * Render one configuration value at full precision, so a table never shows a
 * hyperparameter other than the one that ran.
 * @param value - the value to render.
 * @returns a display string.
 */
export function formatConfigValue(value) {
    if (value === undefined || value === null)
        return '--';
    if (typeof value === 'number')
        return String(roundValue(value));
    if (typeof value === 'string')
        return value;
    if (typeof value === 'boolean')
        return String(value);
    return JSON.stringify(value);
}
/** Stable identity of one JSON value, used to group trials by parameter value. */
function valueKey(value) {
    return JSON.stringify(value === undefined ? null : value);
}
/** Deterministic 32-bit linear-congruential generator; identical seeds give identical plans. */
function makeRng(seed) {
    let state = (Math.floor(seed) >>> 0) || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
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
export function expandParameter(spec) {
    if (isValueList(spec))
        return spec.length > 0 ? [...spec] : null;
    if (!isRangeSpec(spec))
        return null;
    const { min, max, steps } = spec;
    if (!Number.isFinite(min) || !Number.isFinite(max))
        return null;
    if (!Number.isInteger(steps) || steps < 1)
        return null;
    if (steps === 1)
        return [min];
    const values = [];
    if (spec.log === true) {
        // A geometric progression needs strictly positive bounds; a non-positive
        // one has no logarithm and would silently emit NaN as a hyperparameter.
        if (min <= 0 || max <= 0)
            return null;
        const low = Math.log(min);
        const high = Math.log(max);
        for (let index = 0; index < steps; index++) {
            values.push(roundValue(Math.exp(low + (high - low) * index / (steps - 1))));
        }
        return values;
    }
    for (let index = 0; index < steps; index++) {
        values.push(roundValue(min + (max - min) * index / (steps - 1)));
    }
    return values;
}
/** Merge base configuration with one trial's sampled parameter values. */
function mergeConfig(base, sampled) {
    return { ...base, ...sampled };
}
/** Stable identity of one complete configuration, used to reject duplicate samples. */
function configKey(config) {
    const parts = [];
    for (const name of Object.keys(config).sort())
        parts.push(`${name}=${JSON.stringify(config[name])}`);
    return parts.join('|');
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
export function sampleDistinct(names, values, count, seed) {
    const rng = makeRng(seed);
    const seen = new Set();
    const configs = [];
    const attemptLimit = count * SAMPLE_ATTEMPT_FACTOR + SAMPLE_ATTEMPT_FLOOR;
    for (let attempt = 0; attempt < attemptLimit && configs.length < count; attempt++) {
        const candidate = {};
        for (const name of names) {
            const list = values[name];
            if (list === undefined || list.length === 0)
                continue;
            // `noUncheckedIndexedAccess` types this as possibly undefined even though
            // the index is bounded by the list length just above.
            const picked = list[Math.floor(rng() * list.length)];
            if (picked !== undefined)
                candidate[name] = picked;
        }
        const key = configKey(candidate);
        if (seen.has(key))
            continue;
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
        for (const combo of combos) {
            for (const value of list)
                next.push({ ...combo, [name]: value });
        }
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
export function parameterCoverage(names, values, trials) {
    return names.map((name) => {
        const counts = {};
        for (const value of values[name] ?? [])
            counts[valueKey(value)] = 0;
        for (const trial of trials) {
            const key = valueKey(trial.config[name]);
            counts[key] = (counts[key] ?? 0) + 1;
        }
        return { name, counts };
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
export function findConfoundedPairs(names, trials) {
    const active = names.filter((name) => {
        const distinct = new Set();
        for (const trial of trials)
            distinct.add(valueKey(trial.config[name]));
        return distinct.size >= 2;
    });
    const pairs = [];
    for (let a = 0; a < active.length; a++) {
        for (let b = a + 1; b < active.length; b++) {
            const first = active[a];
            const second = active[b];
            if (first === undefined || second === undefined)
                continue;
            const forward = new Map();
            const backward = new Map();
            let bijection = true;
            for (const trial of trials) {
                const keyA = valueKey(trial.config[first]);
                const keyB = valueKey(trial.config[second]);
                const seenB = forward.get(keyA);
                if (seenB === undefined)
                    forward.set(keyA, keyB);
                else if (seenB !== keyB)
                    bijection = false;
                const seenA = backward.get(keyB);
                if (seenA === undefined)
                    backward.set(keyB, keyA);
                else if (seenA !== keyA)
                    bijection = false;
            }
            if (bijection)
                pairs.push({ a: first, b: second });
        }
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
export function planSweep(request) {
    const names = Object.keys(request.space);
    const values = {};
    const invalid = [];
    for (const name of names) {
        const spec = request.space[name];
        if (spec === undefined) {
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
    const usable = names.filter(name => values[name] !== undefined);
    let totalCombinations = 1;
    for (const name of usable)
        totalCombinations *= values[name]?.length ?? 0;
    const completeGridFits = request.strategy === 'grid' && totalCombinations <= request.maxTrials;
    const sampled = !completeGridFits;
    const sampledConfigs = completeGridFits
        ? fullGrid(usable, values)
        : sampleDistinct(usable, values, request.maxTrials, request.seed);
    const trials = sampledConfigs.map((sampledConfig, index) => ({
        id: `t${String(index + 1).padStart(4, '0')}`,
        config: mergeConfig(request.baseConfig, sampledConfig),
    }));
    const untestedValues = parameterCoverage(usable, values, trials)
        .filter(entry => Object.values(entry.counts).some(count => count === 0))
        .map(entry => entry.name);
    return {
        trials,
        values,
        totalCombinations,
        sampled,
        strategy: request.strategy,
        untestedValues,
        confounded: findConfoundedPairs(usable, trials),
        invalid,
    };
}
/**
 * Rank completed trials by one metric.
 * @param trials - candidate trials; those without a numeric value for the metric are skipped.
 * @param metric - the metric name to rank by.
 * @param direction - `max` puts the largest value first, `min` the smallest.
 * @returns ranked entries, best first.
 */
export function rankTrials(trials, metric, direction) {
    const scored = [];
    for (const trial of trials) {
        if (trial.status !== 'ok' || trial.metrics === null)
            continue;
        const value = trial.metrics[metric];
        if (typeof value !== 'number' || !Number.isFinite(value))
            continue;
        scored.push({ trial, value });
    }
    scored.sort((left, right) => direction === 'max' ? right.value - left.value : left.value - right.value);
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
export function marginalEffect(scored, parameter, direction) {
    const groups = new Map();
    for (const entry of scored) {
        const value = entry.trial.config[parameter] ?? null;
        const key = valueKey(value ?? undefined);
        const group = groups.get(key);
        if (group === undefined)
            groups.set(key, { value, sum: entry.value, count: 1 });
        else {
            group.sum += entry.value;
            group.count++;
        }
    }
    const rows = [...groups.values()].map(group => ({
        value: group.value,
        mean: group.sum / group.count,
        count: group.count,
    }));
    rows.sort((left, right) => direction === 'max' ? right.mean - left.mean : left.mean - right.mean);
    return rows;
}
/**
 * Build the per-trial ranking table rows the report renders.
 * @param scored - ranked trials.
 * @param parameters - parameter columns to include, in order.
 * @param limit - maximum number of rows to return.
 * @returns the parameter values of each shown trial, aligned with `parameters`.
 */
export function rankingRows(scored, parameters, limit) {
    return scored.slice(0, limit).map(entry => ({
        id: entry.trial.id,
        value: entry.value,
        cells: parameters.map(parameter => formatConfigValue(entry.trial.config[parameter])),
    }));
}
//# sourceMappingURL=sweep.js.map