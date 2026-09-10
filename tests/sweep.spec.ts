// The engine is pure, so these cover the arithmetic the report's claims rest
// on: expansion, budget handling, and the two design faults (an untested value,
// a confounded pair) that make a published ablation unsupportable.
import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  expandParameter, findConfoundedPairs, formatStat, marginalEffect, planSweep, rankTrials, sampleDistinct,
} from '../src/sweep.ts'
import type { SweepTrial } from '../src/types.ts'

function trial(id: string, config: Record<string, JsonValue>, value: number | null): SweepTrial {
  return {
    id,
    config,
    status: value === null ? 'failed' : 'ok',
    metrics: value === null ? null : { acc: value },
    notes: '',
  }
}

describe('expandParameter', () => {
  it('returns an explicit value list unchanged', () => {
    expect(expandParameter([4096, 8192])).toEqual([4096, 8192])
  })

  it('spreads an arithmetic range across both bounds', () => {
    expect(expandParameter({ min: 0, max: 1, steps: 3 })).toEqual([0, 0.5, 1])
  })

  it('spreads a geometric range so each step scales the previous one', () => {
    expect(expandParameter({ min: 1, max: 100, steps: 3, log: true })).toEqual([1, 10, 100])
  })

  it('returns a single value when steps is one', () => {
    expect(expandParameter({ min: 5, max: 9, steps: 1 })).toEqual([5])
  })

  it('rejects a geometric range with a non-positive bound instead of emitting NaN', () => {
    // Math.log(0) is -Infinity; without this guard the sweep would record a
    // hyperparameter of NaN and every trial of that column would be unusable.
    expect(expandParameter({ min: 0, max: 10, steps: 3, log: true })).toBeNull()
  })

  it('rejects an empty list and a fractional step count', () => {
    expect(expandParameter([])).toBeNull()
    expect(expandParameter({ min: 0, max: 1, steps: 2.5 })).toBeNull()
  })
})

describe('sampleDistinct', () => {
  const values = { a: [1, 2, 3], b: ['x', 'y', 'z'] }

  it('reproduces the same plan for the same seed', () => {
    expect(sampleDistinct(['a', 'b'], values, 5, 7)).toEqual(sampleDistinct(['a', 'b'], values, 5, 7))
  })

  it('never returns the same configuration twice', () => {
    const sampled = sampleDistinct(['a', 'b'], values, 9, 3)
    expect(new Set(sampled.map(config => JSON.stringify(config))).size).toBe(sampled.length)
  })

  it('stops at the size of the space rather than looping forever', () => {
    expect(sampleDistinct(['a', 'b'], values, 50, 1)).toHaveLength(9)
  })
})

describe('planSweep', () => {
  const space = { gate: ['sigmoid', 'silu', 'none'], lr: [1e-5, 1e-4, 1e-3], window: [4096, 8192, 32768] }

  it('enumerates the complete product when it fits the budget', () => {
    const plan = planSweep({ space, baseConfig: { model: 'm' }, strategy: 'grid', maxTrials: 27, seed: 1 })
    expect(plan.trials).toHaveLength(27)
    expect(plan.sampled).toBe(false)
    expect(plan.totalCombinations).toBe(27)
    expect(plan.confounded).toEqual([])
    expect(plan.trials[0]?.config).toMatchObject({ model: 'm' })
  })

  it('keeps every parameter independently attributable when a grid must be sampled', () => {
    // The regression this guards: slicing a product by a fixed stride correlates
    // the dimensions the enumeration order placed together, so the capped plan
    // silently drops a value and makes two components inseparable.
    const plan = planSweep({ space, baseConfig: {}, strategy: 'grid', maxTrials: 12, seed: 1 })
    expect(plan.trials).toHaveLength(12)
    expect(plan.sampled).toBe(true)
    expect(plan.untestedValues).toEqual([])
    expect(plan.confounded).toEqual([])
    for (const parameter of Object.keys(space)) {
      const seen = new Set(plan.trials.map(entry => JSON.stringify(entry.config[parameter])))
      expect(seen.size).toBe(space[parameter as keyof typeof space].length)
    }
  })

  it('names every parameter whose declared value no trial exercises', () => {
    // One value of `gate` is missing from the sampled plan, so the report must
    // be able to say that this parameter's coverage is incomplete.
    const thin = { gate: ['a', 'b', 'c'], lr: [1, 2] }
    const plan = planSweep({ space: thin, baseConfig: {}, strategy: 'grid', maxTrials: 2, seed: 5 })
    expect(plan.trials.length).toBeLessThanOrEqual(2)
    expect(plan.untestedValues.length).toBeGreaterThan(0)
  })

  it('rejects a space entry it cannot expand', () => {
    const plan = planSweep({ space: { lr: [] }, baseConfig: {}, strategy: 'grid', maxTrials: 4, seed: 1 })
    expect(plan.invalid).toHaveLength(1)
    expect(plan.invalid[0]).toContain('lr')
  })
})

describe('findConfoundedPairs', () => {
  it('reports a pair whose values are a bijection', () => {
    const trials = [
      trial('t1', { gate: 'silu', rope: 10000 }, 70),
      trial('t2', { gate: 'none', rope: 100000 }, 68),
    ]
    expect(findConfoundedPairs(['gate', 'rope'], trials)).toEqual([{ a: 'gate', b: 'rope' }])
  })

  it('clears a pair once one trial varies them independently', () => {
    const trials = [
      trial('t1', { gate: 'silu', rope: 10000 }, 70),
      trial('t2', { gate: 'none', rope: 100000 }, 68),
      trial('t3', { gate: 'silu', rope: 100000 }, 71),
    ]
    expect(findConfoundedPairs(['gate', 'rope'], trials)).toEqual([])
  })

  it('ignores a parameter held constant across every trial', () => {
    const trials = [trial('t1', { gate: 'silu', lr: 1 }, 70), trial('t2', { gate: 'none', lr: 1 }, 68)]
    expect(findConfoundedPairs(['gate', 'lr'], trials)).toEqual([])
  })
})

describe('rankTrials', () => {
  const trials = [
    trial('t1', {}, 70),
    trial('t2', {}, 72),
    trial('t3', {}, null),
    { id: 't4', config: {}, status: 'ok', metrics: {}, notes: '' } as SweepTrial,
  ]

  it('orders best first for a maximizing metric and skips trials without the metric', () => {
    expect(rankTrials(trials, 'acc', 'max').map(entry => entry.trial.id)).toEqual(['t2', 't1'])
  })

  it('orders best first for a minimizing metric', () => {
    expect(rankTrials(trials, 'acc', 'min').map(entry => entry.trial.id)).toEqual(['t1', 't2'])
  })
})

describe('marginalEffect', () => {
  it('averages the metric per parameter value and orders the best mean first', () => {
    const scored = rankTrials([
      trial('t1', { gate: 'silu' }, 72),
      trial('t2', { gate: 'silu' }, 70),
      trial('t3', { gate: 'none' }, 68),
    ], 'acc', 'max')
    const rows = marginalEffect(scored, 'gate', 'max')
    expect(rows[0]).toEqual({ value: 'silu', mean: 71, count: 2 })
    expect(rows[1]).toEqual({ value: 'none', mean: 68, count: 1 })
  })
})

describe('formatStat', () => {
  it('keeps configuration-scale values readable without truncating distinct hyperparameters', () => {
    expect(formatStat(72.7)).toBe('72.7')
    expect(formatStat(71.86666666666666)).toBe('71.8667')
    expect(formatStat(4)).toBe('4')
  })

  it('keeps more precision for sub-unit statistics and less for large ones', () => {
    expect(formatStat(0.000123456)).toBe('0.000123')
    expect(formatStat(12345.6789)).toBe('12345.7')
  })
})
