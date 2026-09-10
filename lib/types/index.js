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
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_WHEN_TO_USE } from "./skill.js";
import { findConfoundedPairs, formatConfigValue, formatStat, marginalEffect, planSweep, rankTrials, } from "./sweep.js";
export const name = 'tool-research-campaign';
export const inject = ['tools', 'skills'];
/** Curated name of the skill this package contributes to the session catalogue. */
export const RESEARCH_CAMPAIGN_SKILL = 'research-campaign';
/** Ordered parameter columns a report prints before it elides the remainder. */
const REPORT_PARAMETER_COLUMNS = 6;
/** Rows a report prints when the caller names no limit. */
const DEFAULT_REPORT_ROWS = 10;
/** The three lifecycle states a record call may set. */
const RECORDABLE_STATUSES = ['running', 'ok', 'failed', 'pruned'];
/** Schemastery configuration for the research-campaign consumer. */
export const Config = z.object({
    maxTrialsPerCampaign: z.number().required(),
});
/** Whether a JSON value is a plain object rather than an array or a scalar. */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Validate the model-supplied search space at the tool boundary. The model
 * writes plain JSON, so every shape rule is enforced here rather than trusted.
 * @param value - the raw `space` argument.
 * @returns the validated search space.
 */
function parseSearchSpace(value) {
    if (!isPlainObject(value))
        throw new Error('space must be a JSON object mapping parameter name to values or a range spec');
    const space = {};
    for (const [parameter, spec] of Object.entries(value)) {
        if (Array.isArray(spec)) {
            space[parameter] = spec;
            continue;
        }
        if (!isPlainObject(spec)) {
            throw new Error(`space.${parameter} must be a value array or {min, max, steps, log?}`);
        }
        space[parameter] = spec;
    }
    if (Object.keys(space).length === 0)
        throw new Error('space must declare at least one parameter');
    return space;
}
/**
 * Validate an optional plain-object argument that maps names to JSON values.
 * @param value - the raw argument, absent when the model omitted it.
 * @param label - the argument name used in the failure message.
 * @returns the object, or an empty record when the argument is absent.
 */
function parseRecord(value, label) {
    if (value === undefined)
        return {};
    if (!isPlainObject(value))
        throw new Error(`${label} must be a JSON object`);
    return value;
}
/**
 * Validate an optional metric map. Metrics are the numbers a paper reports, so
 * a non-numeric entry fails loud instead of being dropped from the ranking.
 * @param value - the raw `metrics` argument.
 * @returns validated metric names to finite numbers.
 */
function parseMetrics(value) {
    const raw = parseRecord(value, 'metrics');
    const metrics = {};
    for (const [metric, entry] of Object.entries(raw)) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) {
            throw new Error(`metrics.${metric} must be a finite number`);
        }
        metrics[metric] = entry;
    }
    return metrics;
}
/** Read one campaign for a calling agent, failing loud when the id is unknown. */
function requireCampaign(ledgers, owner, id) {
    const campaign = ledgers.get(owner)?.get(id);
    if (campaign === undefined) {
        const known = [...(ledgers.get(owner)?.keys() ?? [])];
        throw new Error(`unknown campaign ${JSON.stringify(id)} for this session; known: ${known.length === 0 ? 'none' : known.join(', ')}`);
    }
    return campaign;
}
/** Render the ranked table plus every row a reader needs to trust the ranking. */
function renderReport(campaign, metric, direction, topK) {
    const counts = { running: 0, ok: 0, failed: 0, pruned: 0 };
    for (const trial of campaign.trials)
        counts[trial.status]++;
    const scored = rankTrials(campaign.trials, metric, direction);
    const parameters = Object.keys(campaign.values);
    const out = [];
    out.push(`# Sweep report: ${campaign.id}`);
    out.push('');
    out.push(`Metric: ${metric} (${direction === 'max' ? 'maximize' : 'minimize'})`);
    out.push(`Trials: ${counts.ok} ok, ${counts.failed} failed, ${counts.pruned} pruned, ${counts.running} running,`
        + ` out of ${campaign.trials.length} planned over ${campaign.totalCombinations} combinations`);
    out.push('');
    if (scored.length === 0) {
        out.push(`No trial has a numeric ${metric} yet. Record finished runs with research_sweep_record before ranking.`);
        return out.join('\n');
    }
    const baselineValue = campaign.baseline[metric];
    const sotaValue = campaign.sota?.metric === metric ? campaign.sota.value : undefined;
    const delta = (value, reference) => {
        if (reference === undefined)
            return '--';
        const change = value - reference;
        const improved = direction === 'max' ? change > 0 : change < 0;
        return `${change > 0 ? '+' : ''}${formatStat(change)}${improved ? ' WIN' : ''}`;
    };
    const columns = parameters.slice(0, REPORT_PARAMETER_COLUMNS);
    out.push('## Ranking');
    out.push('');
    out.push(`| # | trial | ${metric} | vs baseline | vs SOTA | ${columns.join(' | ')} |`);
    out.push(`| ${['---', '---', '---', '---', '---', ...columns.map(() => '---')].join(' | ')} |`);
    const shown = scored.slice(0, topK);
    shown.forEach((entry, index) => {
        const cells = columns.map(parameter => formatConfigValue(entry.trial.config[parameter]));
        out.push(`| ${index + 1} | ${entry.trial.id} | ${formatStat(entry.value)}`
            + ` | ${delta(entry.value, baselineValue)} | ${delta(entry.value, sotaValue)} | ${cells.join(' | ')} |`);
    });
    if (columns.length < parameters.length) {
        out.push('');
        out.push(`(${parameters.length - columns.length} more parameters are in the ledger but omitted from this table.)`);
    }
    out.push('');
    const best = shown[0];
    if (best === undefined)
        return out.join('\n');
    out.push('## Best configuration');
    out.push('');
    out.push('```json');
    out.push(JSON.stringify(best.trial.config));
    out.push('```');
    out.push('');
    out.push(`Best ${metric}: ${formatStat(best.value)} at trial ${best.trial.id}.`);
    out.push('');
    out.push('## Reference points');
    out.push('');
    out.push(`- baseline: ${baselineValue === undefined ? `not recorded for ${metric}` : formatStat(baselineValue)}`);
    out.push(`- sota target: ${sotaValue === undefined || campaign.sota === null
        ? `not recorded for ${metric}`
        : `${formatStat(sotaValue)}${campaign.sota.source === '' ? '' : ` (${campaign.sota.source})`}`}`);
    if (baselineValue !== undefined) {
        const gain = best.value - baselineValue;
        const relative = baselineValue === 0 ? 'n/a' : `${formatStat(gain / Math.abs(baselineValue) * 100)}%`;
        out.push(`- best over baseline: ${gain > 0 ? '+' : ''}${formatStat(gain)} (${relative})`);
    }
    if (sotaValue !== undefined) {
        const margin = direction === 'max' ? best.value - sotaValue : sotaValue - best.value;
        out.push(`- best over sota target: ${margin > 0 ? '+' : ''}${formatStat(margin)}${margin > 0 ? ' (target beaten)' : ' (target NOT beaten)'}`);
    }
    out.push('');
    const runnerUp = scored[1];
    if (runnerUp !== undefined) {
        out.push('## Noise check');
        out.push('');
        out.push(`- gap between rank 1 and rank 2: ${formatStat(Math.abs(best.value - runnerUp.value))}`);
        const third = scored[2];
        if (third !== undefined)
            out.push(`- gap between rank 1 and rank 3: ${formatStat(Math.abs(best.value - third.value))}`);
        out.push('- if these gaps are smaller than your seed-to-seed variation, the ranking is noise: rerun the top configurations with several seeds before choosing.');
        out.push('');
    }
    const confounded = findConfoundedPairs(parameters, scored.map(entry => entry.trial));
    out.push('## Confounding check');
    out.push('');
    if (confounded.length === 0) {
        out.push('No pair of tested parameters is perfectly correlated, so each parameter has independent evidence.');
    }
    else {
        for (const pair of confounded) {
            out.push(`- ${pair.a} and ${pair.b} always share the same value pairing in the completed trials, so their separate contributions cannot be claimed. Add trials that vary them independently.`);
        }
    }
    out.push('');
    out.push('## Marginal effect by parameter');
    out.push('');
    for (const parameter of parameters) {
        out.push(`### ${parameter}`);
        out.push('');
        out.push(`| value | mean ${metric} | trials |`);
        out.push('| --- | --- | --- |');
        for (const row of marginalEffect(scored, parameter, direction)) {
            out.push(`| ${formatConfigValue(row.value ?? undefined)} | ${formatStat(row.mean)} | ${row.count} |`);
        }
        out.push('');
    }
    const distinctValues = (parameter) => new Set(scored.map(entry => JSON.stringify(entry.trial.config[parameter] ?? null))).size;
    const checklist = [
        [baselineValue !== undefined, `baseline recorded for ${metric}`],
        [sotaValue !== undefined, `SOTA target and source recorded for ${metric}`],
        [counts.ok >= 3, 'at least 3 completed trials'],
        [counts.failed + counts.pruned > 0, 'failed or pruned runs also recorded'],
        [parameters.every(parameter => distinctValues(parameter) >= 2), 'every searched parameter has at least 2 tested values'],
        [confounded.length === 0, 'no parameter pair is confounded'],
    ];
    out.push('## Paper materials checklist');
    out.push('');
    for (const [met, label] of checklist)
        out.push(`- [${met ? 'x' : ' '}] ${label}`);
    out.push('');
    out.push('An unchecked line is a missing item for the methods or experiments section of the paper.');
    return out.join('\n');
}
/**
 * Register the research-campaign skill and its three sweep tools on `ctx`.
 * @param ctx - registrant context carrying the tool and skill registries.
 * @param config - the deployment's explicit trial ceiling.
 */
export function apply(ctx, config) {
    const maxTrialsPerCampaign = config.maxTrialsPerCampaign;
    if (!Number.isInteger(maxTrialsPerCampaign) || maxTrialsPerCampaign < 1) {
        throw new Error('maxTrialsPerCampaign must be a positive integer');
    }
    // One ledger per calling agent: campaigns are session work, and a standing
    // preset mount shares this fiber across every session that joins it.
    const ledgers = new Map();
    ctx.skills.register({
        name: RESEARCH_CAMPAIGN_SKILL,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        source: 'runtime',
        content: SKILL_CONTENT,
    });
    ctx.tools.register(defineTool({
        name: 'research_sweep_plan',
        description: 'Open a tuning ledger and expand a search space into a bounded, de-confounded trial matrix. '
            + 'When the full grid exceeds the budget it samples uniformly instead of truncating, and reports '
            + 'per-value coverage and any parameter pair the plan cannot separate.',
        parameters: {
            campaign: { type: 'string', required: true, description: 'Ledger id, for example resnet-lr-sweep. Must be new.' },
            space: {
                type: 'json',
                required: true,
                description: 'Parameter name to either an explicit value array or a range spec {min, max, steps, log?}. '
                    + 'Every searched parameter belongs here.',
            },
            max_trials: { type: 'integer', required: true, description: 'Hard cap on generated trials.' },
            base_config: { type: 'json', description: 'Configuration merged into every trial, for example unchanged backbone and dataset settings.' },
            strategy: {
                type: 'string',
                enum: ['grid', 'random'],
                description: 'grid expands the full Cartesian product when it fits the budget; random samples distinct configurations with a seeded PRNG. Default grid.',
            },
            seed: { type: 'integer', description: 'Seed for sampling. Default 1.' },
            baseline_metrics: { type: 'json', description: 'Metrics of the unmodified baseline repository, keyed by metric name.' },
            sota_metric: { type: 'string', description: 'Metric name the SOTA target is reported on.' },
            sota_value: { type: 'number', description: 'Current best reported value for that metric.' },
            sota_source: { type: 'string', description: 'Where that number comes from: paper, table, URL, or leaderboard entry.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute(args, exec) {
            const owner = exec.agent;
            if (owner === undefined)
                throw new Error('research_sweep_plan requires an owning agent session');
            const id = args.campaign.trim();
            if (id === '')
                throw new Error('campaign must be a non-empty id');
            const ledger = ledgers.get(owner.id) ?? new Map();
            ledgers.set(owner.id, ledger);
            if (ledger.has(id)) {
                throw new Error(`campaign ${JSON.stringify(id)} already exists; pick a new id rather than reusing a ledger with recorded results`);
            }
            if (args.max_trials > maxTrialsPerCampaign) {
                throw new Error(`max_trials ${args.max_trials} exceeds this deployment's ceiling of ${maxTrialsPerCampaign}`);
            }
            const strategy = args.strategy ?? 'grid';
            const plan = planSweep({
                space: parseSearchSpace(args.space),
                baseConfig: parseRecord(args.base_config, 'base_config'),
                strategy,
                maxTrials: args.max_trials,
                seed: args.seed ?? 1,
            });
            if (plan.invalid.length > 0)
                throw new Error(`invalid search space: ${plan.invalid.join('; ')}`);
            const baseline = parseMetrics(args.baseline_metrics);
            const sota = args.sota_metric !== undefined && args.sota_metric.trim() !== '' && args.sota_value !== undefined
                ? { metric: args.sota_metric.trim(), value: args.sota_value, source: args.sota_source?.trim() ?? '' }
                : null;
            const trials = plan.trials.map(trial => ({
                id: trial.id,
                config: trial.config,
                status: 'running',
                metrics: null,
                notes: '',
            }));
            ledger.set(id, {
                id,
                values: plan.values,
                trials,
                baseline,
                sota,
                strategy,
                sampled: plan.sampled,
                totalCombinations: plan.totalCombinations,
            });
            const out = [];
            out.push(`# Sweep ledger opened: ${id}`);
            out.push('');
            out.push(`Full grid size: ${plan.totalCombinations} combinations`);
            out.push(`Trials generated: ${trials.length} using ${plan.sampled ? `seeded uniform sampling (seed ${args.seed ?? 1})` : 'a complete Cartesian grid'}`);
            if (plan.sampled && strategy === 'grid') {
                out.push('');
                out.push('The full grid exceeded max_trials, so trials were sampled uniformly rather than truncated by stride. A stride slice of a Cartesian product correlates the parameters and destroys ablation attribution.');
            }
            out.push('');
            out.push('Search space:');
            for (const [parameter, values] of Object.entries(plan.values)) {
                const preview = values.length <= 8 ? values.map(value => formatConfigValue(value)).join(', ') : `${values.slice(0, 8).map(value => formatConfigValue(value)).join(', ')}, ...`;
                out.push(`- ${parameter} (${values.length} values): ${preview}`);
            }
            out.push('');
            out.push('Reference points:');
            out.push(`- baseline: ${Object.keys(baseline).length === 0 ? 'not recorded' : JSON.stringify(baseline)}`);
            out.push(`- sota target: ${sota === null ? 'not recorded (record one before claiming SOTA)' : `${sota.metric} = ${sota.value}${sota.source === '' ? '' : ` (${sota.source})`}`}`);
            out.push('');
            out.push('Design checks:');
            out.push(plan.untestedValues.length === 0
                ? '- coverage: every value of every parameter is tested at least once'
                : `- coverage warning: some values are never tested in ${plan.untestedValues.join(', ')}`);
            out.push(plan.confounded.length === 0
                ? '- confounding: no parameter pair is perfectly correlated in this plan'
                : plan.confounded
                    .map(pair => `- confounding warning: ${pair.a} and ${pair.b} move together in every trial, so their individual contributions cannot be attributed. Add trials that vary them independently.`)
                    .join('\n'));
            out.push('');
            out.push('Trials:');
            for (const trial of trials.slice(0, 20))
                out.push(`- ${trial.id}: ${JSON.stringify(trial.config)}`);
            if (trials.length > 20)
                out.push(`- ... and ${trials.length - 20} more`);
            out.push('');
            out.push(`Next: run the pipeline on trial ${trials[0]?.id ?? '(none)'} first, then report every finished trial with research_sweep_record.`);
            return Promise.resolve(out.join('\n'));
        },
        presentCall: args => ({ card: 'generic', title: 'Plan tuning sweep', kind: 'other', rawInput: args.campaign }),
    }));
    ctx.tools.register(defineTool({
        name: 'research_sweep_record',
        description: 'Record one finished trial into the tuning ledger, including failed and pruned runs, '
            + 'so the ledger states how large the search actually was.',
        parameters: {
            campaign: { type: 'string', required: true, description: 'Ledger id created by research_sweep_plan.' },
            trial_id: { type: 'string', required: true, description: 'Trial id such as t0007.' },
            status: {
                type: 'string',
                required: true,
                enum: ['running', 'ok', 'failed', 'pruned'],
                description: 'ok for a completed run with metrics; failed for a crash; pruned for early stopping.',
            },
            metrics: { type: 'json', description: 'Metric name to value for this trial, for example {"accuracy": 72.4}.' },
            notes: { type: 'string', description: 'Short note: error, decision, or config deviation worth keeping.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute(args, exec) {
            const owner = exec.agent;
            if (owner === undefined)
                throw new Error('research_sweep_record requires an owning agent session');
            const campaign = requireCampaign(ledgers, owner.id, args.campaign.trim());
            const trial = campaign.trials.find(candidate => candidate.id === args.trial_id.trim());
            if (trial === undefined) {
                throw new Error(`unknown trial ${JSON.stringify(args.trial_id)} in campaign ${campaign.id}`);
            }
            const metrics = parseMetrics(args.metrics);
            if (args.status === 'ok' && Object.keys(metrics).length === 0) {
                throw new Error('status ok requires at least one metric; use failed or pruned when the run produced no numbers');
            }
            if (!RECORDABLE_STATUSES.includes(args.status)) {
                throw new Error(`status must be one of ${RECORDABLE_STATUSES.join(', ')}`);
            }
            trial.status = args.status;
            if (Object.keys(metrics).length > 0)
                trial.metrics = metrics;
            trial.notes = args.notes ?? '';
            const counts = { running: 0, ok: 0, failed: 0, pruned: 0 };
            for (const entry of campaign.trials)
                counts[entry.status]++;
            const out = [
                `Recorded ${trial.id} as ${trial.status}${Object.keys(metrics).length > 0 ? ` ${JSON.stringify(metrics)}` : ''}.`,
                `Progress: ${counts.ok} ok, ${counts.failed} failed, ${counts.pruned} pruned, ${counts.running} running, out of ${campaign.trials.length} planned.`,
            ];
            if (trial.notes !== '')
                out.push(`Note: ${trial.notes}`);
            return Promise.resolve(out.join('\n'));
        },
        presentCall: args => ({ card: 'generic', title: `Record trial ${args.trial_id}`, kind: 'other', rawInput: args.campaign }),
    }));
    ctx.tools.register(defineTool({
        name: 'research_sweep_report',
        description: 'Rank a tuning ledger by one metric, show the best configuration, the margin against baseline and '
            + 'SOTA target, the marginal effect of every searched parameter, and flag confounded parameter pairs. '
            + 'This is the scoreboard for picking the numbers that go in the paper.',
        parameters: {
            campaign: { type: 'string', required: true, description: 'Ledger id created by research_sweep_plan.' },
            metric: { type: 'string', required: true, description: 'Metric name to rank by, exactly as it was recorded.' },
            direction: {
                type: 'string',
                enum: ['max', 'min'],
                description: 'max for accuracy-like metrics, min for loss-like metrics. Default max.',
            },
            top_k: { type: 'integer', description: 'How many ranked trials to show. Default 10.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute(args, exec) {
            const owner = exec.agent;
            if (owner === undefined)
                throw new Error('research_sweep_report requires an owning agent session');
            const campaign = requireCampaign(ledgers, owner.id, args.campaign.trim());
            const metric = args.metric.trim();
            if (metric === '')
                throw new Error('metric must be a non-empty name');
            const topK = args.top_k ?? DEFAULT_REPORT_ROWS;
            if (!Number.isInteger(topK) || topK < 1)
                throw new Error('top_k must be a positive integer');
            return Promise.resolve(renderReport(campaign, metric, args.direction ?? 'max', topK));
        },
        presentCall: args => ({ card: 'generic', title: `Sweep report by ${args.metric}`, kind: 'other', rawInput: args.campaign }),
    }));
}
//# sourceMappingURL=index.js.map