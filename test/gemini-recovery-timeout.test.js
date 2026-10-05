'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const config = require('../src/config')
const { requestGemini, translateCues } = require('../src/translator')

function translatedBody(text = 'Hai') {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: [{ id: 0, text }] }) }] } }] }
}
function goodResponse() {
  return { ok: true, status: 200, json: async () => translatedBody() }
}
function cue(i) {
  return { time: `00:00:0${i}.000 --> 00:00:09.000`, text: `line-${i}` }
}

test('Gemini request timeout defaults to 45 seconds and transient retry starts at 2 seconds', () => {
  assert.equal(config.geminiTimeoutMs, 45000)
  assert.equal(config.geminiRetryBaseMs, 2000)
})

test('a slow but successful Gemini response does not trigger a retry', async () => {
  let calls = 0
  let sleeps = 0
  const response = await requestGemini('prompt', {
    apiKey: 'test', timeoutMs: 70, retries: 1,
    fetchImpl: async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 35))
      return goodResponse()
    },
    sleepFn: async () => { sleeps++ }
  })
  assert.equal(calls, 1)
  assert.equal(sleeps, 0)
  assert.deepEqual(response, translatedBody())
})

test('repeated Gemini 503 uses increasing backoff and preserves a successful result', async () => {
  let calls = 0
  const sleeps = []
  const metrics = { geminiCalls: 0, transientRetries: 0, retryWaitMs: 0 }
  const result = await requestGemini('prompt', {
    apiKey: 'test', retries: 2, jitterFn: () => 0,
    sleepFn: async ms => sleeps.push(ms), requestMetrics: metrics,
    fetchImpl: async () => {
      calls++
      return calls < 3
        ? { ok: false, status: 503, headers: { get: () => null } }
        : goodResponse()
    }
  })
  assert.deepEqual(result, translatedBody())
  assert.deepEqual(sleeps, [2000, 4000])
  assert.equal(metrics.transientRetries, 2)
  assert.equal(metrics.retryWaitMs, 6000)
  assert.deepEqual(metrics.geminiStatuses, [503, 503, 200])
})

test('only an aborted chunk is retried after a fast 1 second delay', async () => {
  const cues = [cue(0), cue(1), cue(2), cue(3)]
  const calls = new Map()
  const sleeps = []
  let summary
  const translated = await translateCues(cues, {
    maxItems: 2, maxChars: 20000, concurrency: 2,
    sleepFn: async ms => sleeps.push(ms),
    translateTextsFn: async (texts, options) => {
      const id = texts[0]
      const n = (calls.get(id) || 0) + 1
      calls.set(id, n)
      if (id === 'line-0' && n === 1) {
        const e = new Error('The operation was aborted')
        e.name = 'AbortError'
        throw e
      }
      await options.onTranslationStats({ expected: texts.length, received: texts.length, missing: 0, retryRecovered: 0, fallbackCount: 0, final: texts.length })
      return texts.map(text => `BM:${text}`)
    },
    onTranslationStats: value => { summary = value }
  })
  assert.deepEqual(sleeps, [1000])
  assert.deepEqual(Object.fromEntries(calls), { 'line-0': 2, 'line-2': 1 })
  assert.deepEqual(translated.map(row => row.text), ['BM:line-0', 'BM:line-1', 'BM:line-2', 'BM:line-3'])
  assert.equal(summary.abortRetries, 1)
  assert.equal(summary.retryWaitMs, 1000)
})

test('an explicit zero retry delay remains available for existing test and call-site overrides', async () => {
  const sleeps = []
  let count = 0
  await translateCues([cue(0)], {
    maxItems: 1, concurrency: 1, abortRetryDelayMs: 0,
    sleepFn: async ms => sleeps.push(ms),
    translateTextsFn: async texts => {
      count++
      if (count === 1) { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
      return texts
    }
  })
  assert.equal(count, 2)
  assert.deepEqual(sleeps, [])
})
