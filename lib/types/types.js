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
export {};
//# sourceMappingURL=types.js.map