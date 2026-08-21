'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  chunkCues,
  createTranslationPlan,
  requestGemini,
  translateCues
} = require('../src/translator')

function cue(i, text = `Line ${i}`) {
  return {
    time: `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:59.000`,
    text
  }
}

test('M14.1 restores stable 180 cue batching for 1229 cues', () => {
  const cues = Array.from({ length: 1229 }, (_, i) => cue(i))
  const plan = createTranslationPlan(cues)
  const chunks = chunkCues(cues, plan.maxItems, plan.maxChars)
  assert.equal(plan.maxItems, 180)
  assert.equal(plan.maxChars, 24000)
  assert.equal(plan.concurrency, 2)
  assert.deepEqual(chunks.map(x => x.length), [180, 180, 180, 180, 180, 180, 149])
})

test('M14.1 restores stable five chunks for 771 cues', () => {
  const cues = Array.from({ length: 771 }, (_, i) => cue(i))
  const plan = createTranslationPlan(cues)
  const chunks = chunkCues(cues, plan.maxItems, plan.maxChars)
  assert.equal(plan.maxItems, 180)
  assert.equal(plan.concurrency, 2)
  assert.deepEqual(chunks.map(x => x.length), [180, 180, 180, 180, 51])
})

test('M14.1 honours explicit translation settings', () => {
  const plan = createTranslationPlan([cue(0), cue(1)], {
    maxItems: 1,
    maxChars: 1000,
    concurrency: 1
  })
  assert.equal(plan.maxItems, 1)
  assert.equal(plan.maxChars, 1000)
  assert.equal(plan.concurrency, 1)
})

test('M14 minimal thinking and Retry-After metrics remain enabled', async () => {
  const bodies = []
  const sleeps = []
  const metrics = { geminiCalls: 0, rateLimits: 0, transientRetries: 0, retryWaitMs: 0 }
  let call = 0

  const fetchImpl = async (_url, init) => {
    call++
    bodies.push(JSON.parse(init.body))
    if (call === 1) {
      return {
        ok: false,
        status: 429,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'retry-after' ? '2' : null
          }
        }
      }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({ translations: [{ id: 0, text: 'Hai' }] })
            }]
          }
        }]
      })
    }
  }

  await requestGemini('test', {
    apiKey: 'fake',
    model: 'gemini-test',
    fetchImpl,
    retries: 1,
    retryBaseMs: 10,
    jitterFn: () => 0,
    sleepFn: async ms => sleeps.push(ms),
    requestMetrics: metrics
  })

  assert.equal(bodies[0].generationConfig.temperature, undefined)
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'minimal')
  assert.deepEqual(sleeps, [2000])
  assert.equal(metrics.geminiCalls, 2)
  assert.equal(metrics.rateLimits, 1)
  assert.equal(metrics.transientRetries, 1)
  assert.equal(metrics.retryWaitMs, 2000)

  // M19 adds performance instrumentation to the same metrics object.
  assert.deepEqual(metrics.geminiStatuses, [429, 200])
  assert.deepEqual(metrics.geminiPromptChars, [4, 4])
  assert.equal(metrics.geminiCallMs.length, 2)
  assert.ok(metrics.geminiCallMs.every(ms => Number.isFinite(ms) && ms >= 0))
})

test('M14.1 default translation uses concurrency two and keeps metrics', async () => {
  const cues = Array.from({ length: 771 }, (_, i) => cue(i))
  let active = 0
  let maxActive = 0
  let calls = 0
  let stats

  const output = await translateCues(cues, {
    translateTextsFn: async (texts, options) => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      await options.onTranslationStats({
        expected: texts.length,
        received: texts.length,
        missing: 0,
        retryRecovered: 0,
        fallbackCount: 0,
        final: texts.length,
        semanticRetriesUsed: 0
      })
      return texts.map(text => `BM:${text}`)
    },
    onTranslationStats: value => { stats = value }
  })

  assert.equal(output.length, 771)
  assert.equal(calls, 5)
  assert.equal(maxActive, 2)
  assert.equal(stats.chunks, 5)
  assert.equal(stats.chunkItems, 180)
  assert.equal(stats.chunkChars, 24000)
  assert.equal(stats.concurrency, 2)
})
