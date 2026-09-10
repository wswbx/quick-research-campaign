// Real Loader composition: the row is booted from a cordis.yml through the
// actual Loader and app tree, so config validation, injection, and the
// model-visible tool list are exercised the way a deployment reaches them.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ResearchCampaign from '@deepseek-ai/dsh-tool-research-campaign'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build one registered agent so tool execution has an owning session to key on. */
function agent(ctx: Context, id: string): Agent {
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId(id)
  const value: Agent = {
    id: sessionId, options: {}, session: Session.create(sessionId), inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

/** Concatenate the text blocks of one tool result. */
function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Call one tool as a registered agent. */
async function call(ctx: Context, owner: Agent, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`${name}-${Math.random()}`),
    name,
    arguments: args,
    agent: owner,
  })
}

/**
 * Boot a cordis.yml carrying the given config lines for this row.
 * @param configLines - YAML lines nested under the row's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-campaign-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-tool-research-campaign'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-tool-research-campaign', ResearchCampaign],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

const SPACE = { gate: ['sigmoid', 'silu', 'none'], lr: [1e-5, 1e-4, 1e-3] }

describe('tool-research-campaign real Loader composition', () => {
  it('plans, records, and reports one campaign end to end', async () => {
    const ctx = await boot(['    maxTrialsPerCampaign: 12'])
    const owner = agent(ctx, 'campaign-owner')

    const planned = await call(ctx, owner, 'research_sweep_plan', {
      campaign: 'longctx',
      space: SPACE,
      max_trials: 9,
      baseline_metrics: { acc: 68.1 },
      sota_metric: 'acc',
      sota_value: 71.2,
      sota_source: 'arXiv:2601.00001v3 Table 2',
    })
    expect(planned.isError).toBe(false)
    expect(resultText(planned)).toContain('# Sweep ledger opened: longctx')
    expect(resultText(planned)).toContain('- baseline: {"acc":68.1}')
    expect(resultText(planned)).toContain('- sota target: acc = 71.2 (arXiv:2601.00001v3 Table 2)')
    expect(resultText(planned)).toContain('coverage: every value of every parameter is tested at least once')

    for (const [id, value] of [['t0001', 72.7], ['t0002', 68.4]] as const) {
      const recorded = await call(ctx, owner, 'research_sweep_record', { campaign: 'longctx', trial_id: id, status: 'ok', metrics: { acc: value } })
      expect(recorded.isError).toBe(false)
    }
    const crashed = await call(ctx, owner, 'research_sweep_record', {
      campaign: 'longctx', trial_id: 't0003', status: 'failed', notes: 'CUDA OOM',
    })
    expect(resultText(crashed)).toContain('Recorded t0003 as failed.')
    expect(resultText(crashed)).toContain('Note: CUDA OOM')

    const report = await call(ctx, owner, 'research_sweep_report', { campaign: 'longctx', metric: 'acc', direction: 'max', top_k: 2 })
    const text = resultText(report)
    expect(report.isError).toBe(false)
    expect(text).toContain('| 1 | t0001 | 72.7 | +4.6 WIN | +1.5 WIN |')
    expect(text).toContain('- best over sota target: +1.5 (target beaten)')
    expect(text).toContain('- [x] failed or pruned runs also recorded')
    expect(text).toContain('- [ ] at least 3 completed trials')
  }, 30_000)

  it('refuses a plan above the deployment ceiling instead of truncating it', async () => {
    const ctx = await boot(['    maxTrialsPerCampaign: 4'])
    const owner = agent(ctx, 'capped-owner')
    const rejected = await call(ctx, owner, 'research_sweep_plan', { campaign: 'too-big', space: SPACE, max_trials: 9 })
    expect(rejected.isError).toBe(true)
    expect(resultText(rejected)).toContain("exceeds this deployment's ceiling of 4")
  }, 30_000)

  it('keeps two sessions\u2019 ledgers apart', async () => {
    const ctx = await boot(['    maxTrialsPerCampaign: 12'])
    const first = agent(ctx, 'session-one')
    const second = agent(ctx, 'session-two')
    await call(ctx, first, 'research_sweep_plan', { campaign: 'shared-id', space: SPACE, max_trials: 3 })
    const missing = await call(ctx, second, 'research_sweep_report', { campaign: 'shared-id', metric: 'acc' })
    expect(missing.isError).toBe(true)
    expect(resultText(missing)).toContain('unknown campaign "shared-id" for this session')
  }, 30_000)

  it('rejects a caller with no owning agent session', async () => {
    const ctx = await boot(['    maxTrialsPerCampaign: 12'])
    const orphan = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('orphan'),
      name: 'research_sweep_plan',
      arguments: { campaign: 'orphan', space: SPACE, max_trials: 3 },
    })
    expect(orphan.isError).toBe(true)
    expect(resultText(orphan)).toContain('requires an owning agent session')
  }, 30_000)

  it.each([
    { label: 'is omitted', configLines: [], failure: '$.maxTrialsPerCampaign missing required value' },
    { label: 'is a string', configLines: ['    maxTrialsPerCampaign: "many"'], failure: '$.maxTrialsPerCampaign expected number' },
  ])('fails loading when maxTrialsPerCampaign $label', async ({ configLines, failure }) => {
    // The ceiling is self-contained, so misconfiguration fails at load rather
    // than surfacing as a silently unbounded plan in some later session.
    await expect(boot(configLines)).rejects.toThrow(failure)
  }, 30_000)
})

describe('tool-research-campaign registration and disposal', () => {
  it('withdraws both the tools and the skill when its fiber is disposed', async () => {
    const ctx = new Context()
    // The tool registry is the package's other injected service and stays
    // pending without the prompt registry it assembles against.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(ResearchCampaign, { maxTrialsPerCampaign: 8 })

    expect(ctx.tools.get('research_sweep_plan')).toBeDefined()
    expect(ctx.tools.get('research_sweep_report')).toBeDefined()
    expect((await ctx.skills.list()).map(summary => summary.name)).toEqual(['research-campaign'])
    expect((await ctx.skills.get('research-campaign'))?.content).toContain('### 1. 立靶')

    await fiber.dispose()
    expect(ctx.tools.get('research_sweep_plan')).toBeUndefined()
    expect(ctx.tools.get('research_sweep_report')).toBeUndefined()
    expect(await ctx.skills.list()).toEqual([])
  }, 30_000)
})
