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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-research-campaign";
export declare const inject: string[];
/** Curated name of the skill this package contributes to the session catalogue. */
export declare const RESEARCH_CAMPAIGN_SKILL = "research-campaign";
/** Deployment configuration for the research-campaign tool consumer. */
export interface Config {
    /**
     * Required ceiling on how many trials one campaign may plan. The ledger is
     * in-memory, so this bound is what keeps a mistaken space declaration from
     * materializing an unbounded matrix; a `plan` call above it is rejected
     * rather than truncated.
     */
    maxTrialsPerCampaign: number;
}
/** Schemastery configuration for the research-campaign consumer. */
export declare const Config: z<Config>;
/**
 * Register the research-campaign skill and its three sweep tools on `ctx`.
 * @param ctx - registrant context carrying the tool and skill registries.
 * @param config - the deployment's explicit trial ceiling.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map