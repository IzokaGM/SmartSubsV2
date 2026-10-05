'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { translateCues, requestGemini } = require('../src/translator')

function cue(text = 'hello') {
  return { time: '00:00:01.000 --> 00:00:02.000', text }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timer)
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener?.('abort', abort, { once: true })
  })
}

test('movie starts a hedge after the configured delay and uses the faster replica', async () => {
  let calls = 0
  let stats
  const translated = await translateCues([cue()], {
    mediaType: 'movie',
    maxItems: 160,
    maxChars: 20000,
    concurrency: 5,
    movieHedgeDelayMs: 10,
    translateTextsFn: async (texts, options) => {
      calls++
      const call = calls
      await wait(call === 1 ? 40 : 5, options.signal)
      await options.onTranslationStats?.({
        expected: texts.length, received: texts.length, missing: 0,
        retryRecovered: 0, fallbackCount: 0, final: texts.length,
        semanticRetriesUsed: 0
      })
      return texts.map(text => `BM${call}:${text}`)
    },
    onTranslationStats: value => { stats = value }
  })

  assert.equal(calls, 2)
  assert.equal(translated[0].text, 'BM2:hello')
  assert.equal(stats.hedgeStarts, 1)
  assert.equal(stats.hedgeReplicaWins, 1)
  assert.equal(stats.hedgeCancels, 1)
})

test('series never starts the movie hedge', async () => {
  let calls = 0
  let stats
  const translated = await translateCues([cue()], {
    mediaType: 'series',
    maxItems: 160,
    concurrency: 5,
    movieHedgeDelayMs: 1,
    translateTextsFn: async (texts, options) => {
      calls++
      await wait(8, options.signal)
      await options.onTranslationStats?.({
        expected: texts.length, received: texts.length, missing: 0,
        retryRecovered: 0, fallbackCount: 0, final: texts.length,
        semanticRetriesUsed: 0
      })
      return texts.map(text => `BM:${text}`)
    },
    onTranslationStats: value => { stats = value }
  })

  assert.equal(calls, 1)
  assert.equal(translated[0].text, 'BM:hello')
  assert.equal(stats.hedgeStarts, 0)
})

test('external hedge cancellation is labelled separately from a real ABORT', async () => {
  const controller = new AbortController()
  const metrics = { geminiCalls: 0, geminiStatuses: [], geminiCallMs: [] }
  const pending = requestGemini('prompt', {
    apiKey: 'test',
    retries: 0,
    timeoutMs: 1000,
    signal: controller.signal,
    requestMetrics: metrics,
    fetchImpl: async (_url, options) => {
      await wait(500, options.signal)
      return { ok: true, status: 200, json: async () => ({ candidates: [] }) }
    }
  })
  setTimeout(() => controller.abort('hedge-loser'), 10)
  await assert.rejects(pending, /aborted/i)
  assert.deepEqual(metrics.geminiStatuses, ['HEDGE_CANCEL'])
})
