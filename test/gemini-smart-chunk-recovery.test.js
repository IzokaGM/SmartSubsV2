'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { translateCues } = require('../src/translator')

function cues(count) {
  return Array.from({ length: count }, (_, index) => ({
    time: `00:00:${String(index).padStart(2, '0')}.000 --> 00:01:00.000`,
    text: `line-${index}`
  }))
}

function aborted() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function completeTexts(texts, options) {
  return Promise.resolve(options.onTranslationStats?.({
    expected: texts.length, received: texts.length, missing: 0,
    retryRecovered: 0, fallbackCount: 0, final: texts.length,
    semanticRetriesUsed: 0
  })).then(() => texts.map(text => `BM:${text}`))
}

test('repeated ABORT splits only one failed chunk; preserves successful parallel chunks and cue timing', async () => {
  const calls = []
  let stats
  const source = cues(12)
  const result = await translateCues(source, {
    maxItems: 4, maxChars: 20000, concurrency: 3,
    abortRetryDelayMs: 0,
    translateTextsFn: async (texts, options) => {
      calls.push(texts.map(text => Number(text.split('-')[1])))
      if (texts.length === 4 && texts[0] === 'line-4') throw aborted()
      return completeTexts(texts, options)
    },
    onTranslationStats: value => { stats = value }
  })
  assert.deepEqual(calls, [
    [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11],
    [4, 5, 6, 7], [4, 5], [6, 7]
  ])
  assert.deepEqual(result.map(item => item.text), source.map(item => `BM:${item.text}`))
  assert.deepEqual(result.map(item => item.time), source.map(item => item.time))
  assert.equal(stats.expected, 12)
  assert.equal(stats.final, 12)
  assert.equal(stats.fallbackCount, 0)
  assert.equal(stats.chunks, 3)
  assert.equal(stats.recoverySplits, 1)
  assert.equal(stats.abortRetries, 1)
})

test('normal translation adds no extra calls or smaller-chunk work', async () => {
  const calls = []
  let stats
  const result = await translateCues(cues(9), {
    maxItems: 4, maxChars: 20000, concurrency: 3,
    translateTextsFn: async (texts, options) => {
      calls.push(texts.length)
      return completeTexts(texts, options)
    },
    onTranslationStats: value => { stats = value }
  })
  assert.deepEqual(calls, [4, 4, 1])
  assert.equal(result.length, 9)
  assert.equal(stats.recoverySplits, 0)
})

test('repeated HTTP 503 does not split a chunk or bypass Queue fallback', async () => {
  const calls = []
  await assert.rejects(translateCues(cues(4), {
    maxItems: 4, concurrency: 1, abortRetryDelayMs: 0,
    translateTextsFn: async texts => {
      calls.push(texts.length)
      throw new Error('Gemini HTTP 503')
    }
  }), /Gemini HTTP 503/)
  assert.deepEqual(calls, [4])
})

test('failed split remains a failed Queue job and never creates an incomplete VTT', async () => {
  const calls = []
  await assert.rejects(translateCues(cues(4), {
    maxItems: 4, concurrency: 1, abortRetryDelayMs: 0,
    translateTextsFn: async (texts, options) => {
      calls.push(texts[0])
      if (texts.length === 4 || texts[0] === 'line-2') throw aborted()
      return completeTexts(texts, options)
    }
  }), /aborted/i)
  assert.deepEqual(calls, ['line-0', 'line-0', 'line-0', 'line-2'])
})

test('wait for other active workers to settle before reporting a failed job and starting Queue retry', async () => {
  let releaseOther
  let otherStarted
  const otherStartedPromise = new Promise(resolve => { otherStarted = resolve })
  const otherDone = new Promise(resolve => { releaseOther = resolve })
  let reported = false
  const job = translateCues(cues(12), {
    maxItems: 4, concurrency: 2, abortRetryDelayMs: 0,
    translateTextsFn: async (texts, options) => {
      if (texts[0] === 'line-4') {
        otherStarted()
        await otherDone
        return completeTexts(texts, options)
      }
      throw new Error('Gemini HTTP 503')
    }
  }).catch(error => { reported = true; throw error })
  await otherStartedPromise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reported, false, 'Queue must not retry while a previous worker is active')
  releaseOther()
  await assert.rejects(job, /Gemini HTTP 503/)
  assert.equal(reported, true)
})

test('malformed recovery output cannot silently shift cue IDs or timestamps', async () => {
  await assert.rejects(translateCues(cues(4), {
    maxItems: 4, concurrency: 1, abortRetryDelayMs: 0,
    translateTextsFn: async texts => {
      if (texts.length === 4) throw aborted()
      return ['one translation only']
    }
  }), /translation count mismatch/)
})
