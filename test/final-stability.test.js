'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { translateCues } = require('../src/translator')

function cue(i) {
  return {
    time: `00:00:${String(i).padStart(2, '0')}.000 --> 00:00:59.000`,
    text: `line-${i}`
  }
}

test('FINAL R2 retries only the aborted chunk and preserves completed chunks', async () => {
  const cues = Array.from({ length: 5 }, (_, i) => cue(i))
  const attempts = new Map()
  let stats

  const output = await translateCues(cues, {
    maxItems: 2,
    maxChars: 20000,
    concurrency: 2,
    abortRetryDelayMs: 0,
    translateTextsFn: async (texts, options) => {
      const key = texts[0]
      const count = (attempts.get(key) || 0) + 1
      attempts.set(key, count)

      if (key === 'line-2' && count === 1) {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      }

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
    onTranslationStats: value => {
      stats = value
    }
  })

  assert.deepEqual(
    Object.fromEntries(attempts),
    {
      'line-0': 1,
      'line-2': 2,
      'line-4': 1
    }
  )
  assert.deepEqual(output.map(item => item.text), [
    'BM:line-0',
    'BM:line-1',
    'BM:line-2',
    'BM:line-3',
    'BM:line-4'
  ])
  assert.equal(stats.abortRetries, 1)
  assert.equal(stats.transientRetries, 1)
  assert.equal(stats.fallbackCount, 0)
  assert.equal(stats.final, 5)
})

test('FINAL R2 caps same-chunk Abort retry at one', async () => {
  const cues = [cue(0), cue(1)]
  let calls = 0

  await assert.rejects(
    translateCues(cues, {
      maxItems: 2,
      maxChars: 20000,
      concurrency: 1,
      abortRetryDelayMs: 0,
      translateTextsFn: async () => {
        calls++
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      }
    }),
    /aborted/i
  )

  assert.equal(calls, 2)
})

test('FINAL R2 production profile is 160/20000/3 and whole-job fallback stays conservative', async () => {
  const { queueTranslationOptions } = await import('../src/cloudflare-worker.mjs')

  const env = {
    QUEUE_FINAL_CHUNK_ITEMS: '160',
    QUEUE_FINAL_CHUNK_CHARS: '20000',
    QUEUE_FINAL_CONCURRENCY: '3',
    QUEUE_PARALLEL_CHUNK_ITEMS: '160',
    QUEUE_PARALLEL_CHUNK_CHARS: '20000',
    QUEUE_PARALLEL_CONCURRENCY: '3',
    QUEUE_FALLBACK_CHUNK_ITEMS: '180',
    QUEUE_FALLBACK_CHUNK_CHARS: '24000',
    QUEUE_FALLBACK_CONCURRENCY: '2'
  }

  assert.deepEqual(queueTranslationOptions(env, 1), {
    maxItems: 160,
    maxChars: 20000,
    concurrency: 3
  })

  assert.deepEqual(queueTranslationOptions(env, 2), {
    maxItems: 180,
    maxChars: 24000,
    concurrency: 2
  })
})

test('FINAL R2 keeps public hardening and Queue serialization', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.QUEUE_FINAL_CHUNK_ITEMS, '160')
  assert.equal(config.vars.QUEUE_FINAL_CHUNK_CHARS, '20000')
  assert.equal(config.vars.QUEUE_FINAL_CONCURRENCY, '3')
  assert.equal(config.queues.consumers[0].max_concurrency, 1)
  assert.equal(config.ratelimits[0].name, 'SMARTSUBS_SUBTITLE_LIMITER')
  assert.equal(config.ratelimits[1].name, 'SMARTSUBS_GENERATE_LIMITER')
})
