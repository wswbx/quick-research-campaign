// End-to-end check of the SHIPPED artifact: this imports the published
// `lib/index.js` (not the sources) and drives the three tools through the real
// tool pipeline, then proves disposal withdraws them.
//
// Run with: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../lib/index.js'

const SPACE = { gate_type: ['sigmoid', 'silu', 'none'], lr: [1e-5, 1e-4, 1e-3] }

function textOf(result) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(plugin, { maxTrialsPerCampaign: 12 })

  const id = SessionId('smoke-session')
  const scope = ctx.plugin(() => {})
  const agent = {
    id, options: {}, session: Session.create(id), inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return { ctx, fiber, agent }
}

async function call(ctx, agent, name, args) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`${name}-smoke`),
    name,
    arguments: args,
    agent,
  })
}

test('the plugin exports the bundle contract', () => {
  assert.equal(plugin.name, 'tool-research-campaign')
  assert.deepEqual(plugin.inject, ['tools', 'skills'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.Config !== undefined, true)
})

test('mounts, plans, records, reports, and disposes', async () => {
  const { ctx, fiber, agent } = await boot()

  assert.notEqual(ctx.tools.get('research_sweep_plan'), undefined)
  assert.notEqual(ctx.tools.get('research_sweep_record'), undefined)
  assert.notEqual(ctx.tools.get('research_sweep_report'), undefined)
  assert.deepEqual((await ctx.skills.list()).map(s => s.name), ['research-campaign'])

  const planned = await call(ctx, agent, 'research_sweep_plan', {
    campaign: 'smoke',
    space: SPACE,
    max_trials: 9,
    baseline_metrics: { acc: 68.1 },
    sota_metric: 'acc',
    sota_value: 71.2,
    sota_source: 'arXiv:2601.00001v3 Table 2',
  })
  assert.equal(planned.isError, false)
  assert.match(textOf(planned), /# Sweep ledger opened: smoke/)
  assert.match(textOf(planned), /coverage: every value of every parameter is tested at least once/)
  assert.match(textOf(planned), /confounding: no parameter pair is perfectly correlated/)

  for (const [id, value] of [['t0001', 72.7], ['t0002', 68.4]]) {
    const recorded = await call(ctx, agent, 'research_sweep_record', {
      campaign: 'smoke', trial_id: id, status: 'ok', metrics: { acc: value },
    })
    assert.equal(recorded.isError, false)
  }
  const crashed = await call(ctx, agent, 'research_sweep_record', {
    campaign: 'smoke', trial_id: 't0003', status: 'failed', notes: 'CUDA OOM',
  })
  assert.match(textOf(crashed), /Note: CUDA OOM/)

  const report = await call(ctx, agent, 'research_sweep_report', {
    campaign: 'smoke', metric: 'acc', direction: 'max', top_k: 2,
  })
  assert.equal(report.isError, false)
  const text = textOf(report)
  assert.match(text, /\| 1 \| t0001 \| 72\.7 \| \+4\.6 WIN \| \+1\.5 WIN \|/)
  assert.match(text, /- best over sota target: \+1\.5 \(target beaten\)/)
  assert.match(text, /- \[x\] failed or pruned runs also recorded/)
  assert.match(text, /- \[ \] at least 3 completed trials/)

  await fiber.dispose()
  assert.equal(ctx.tools.get('research_sweep_plan'), undefined)
  assert.deepEqual(await ctx.skills.list(), [])
})

test('rejects a plan above the configured ceiling', async () => {
  const { ctx, agent } = await boot()
  const rejected = await call(ctx, agent, 'research_sweep_plan', {
    campaign: 'too-big', space: SPACE, max_trials: 99,
  })
  assert.equal(rejected.isError, true)
  assert.match(textOf(rejected), /exceeds this deployment's ceiling of 12/)
})

test('rejects a caller with no owning agent session', async () => {
  const { ctx } = await boot()
  const orphan = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('orphan'),
    name: 'research_sweep_plan',
    arguments: { campaign: 'orphan', space: SPACE, max_trials: 3 },
  })
  assert.equal(orphan.isError, true)
  assert.match(textOf(orphan), /requires an owning agent session/)
})
