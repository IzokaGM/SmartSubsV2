'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { translateCues } = require('../src/translator')

function cue(i) {
  return {
    time: `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:59.000`,
    text: `line-${i}`
  }
}

test('M17 splits 650 cues into five chunks and runs three Gemini jobs in parallel', async () => {
  const cues = Array.from({ length: 650 }, (_, i) => cue(i))
  let active = 0
  let maxActive = 0
  let calls = 0
  let stats

  const output = await translateCues(cues, {
    maxItems: 160,
    maxChars: 20000,
    concurrency: 3,
    translateTextsFn: async (texts, options) => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
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
    onTranslationStats: value => {
      stats = value
    }
  })

  assert.equal(calls, 5)
  assert.equal(maxActive, 3)
  assert.equal(output.length, 650)
  assert.equal(output[0].text, 'BM:line-0')
  assert.equal(output[649].text, 'BM:line-649')
  assert.equal(stats.chunks, 5)
  assert.equal(stats.chunkItems, 160)
  assert.equal(stats.chunkChars, 20000)
  assert.equal(stats.concurrency, 3)
  assert.equal(stats.final, 650)
  assert.equal(stats.fallbackCount, 0)
})

test('M17 Queue first attempt uses parallel profile and retry falls back stable', async () => {
  const { queueTranslationOptions } = await import('../src/cloudflare-worker.mjs')

  const env = {
    QUEUE_TRANSLATION_CHUNK_ITEMS: '240',
    QUEUE_TRANSLATION_CHUNK_CHARS: '30000',
    QUEUE_TRANSLATION_CONCURRENCY: '2',
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

test('M17 remains M16-compatible when new parallel vars are absent', async () => {
  const { queueTranslationOptions } = await import('../src/cloudflare-worker.mjs')

  assert.deepEqual(queueTranslationOptions({
    QUEUE_TRANSLATION_CHUNK_ITEMS: '240',
    QUEUE_TRANSLATION_CHUNK_CHARS: '30000',
    QUEUE_TRANSLATION_CONCURRENCY: '2'
  }, 1), {
    maxItems: 240,
    maxChars: 30000,
    concurrency: 2
  })
})

test('M17 production vars keep direct fallback untouched', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.TRANSLATION_CHUNK_ITEMS, '180')
  assert.equal(config.vars.TRANSLATION_CHUNK_CHARS, '24000')
  assert.equal(config.vars.TRANSLATION_CONCURRENCY, '2')

  assert.equal(config.vars.QUEUE_TRANSLATION_CHUNK_ITEMS, '240')
  assert.equal(config.vars.QUEUE_TRANSLATION_CHUNK_CHARS, '30000')
  assert.equal(config.vars.QUEUE_TRANSLATION_CONCURRENCY, '2')

  assert.equal(config.vars.QUEUE_PARALLEL_CHUNK_ITEMS, '160')
  assert.equal(config.vars.QUEUE_PARALLEL_CHUNK_CHARS, '20000')
  assert.equal(config.vars.QUEUE_PARALLEL_CONCURRENCY, '3')

  assert.equal(config.vars.QUEUE_FALLBACK_CHUNK_ITEMS, '180')
  assert.equal(config.vars.QUEUE_FALLBACK_CHUNK_CHARS, '24000')
  assert.equal(config.vars.QUEUE_FALLBACK_CONCURRENCY, '2')
})

test('M17 queue consumer start diagnose exposes active parallel profile', async () => {
  const { processQueueMessage } = await import('../src/cloudflare-worker.mjs')
  const { createTranslationToken } = require('../src/token')
  const { createUserConfigToken } = require('../src/user-config')

  const secret = 'm17-secret'
  const configToken = createUserConfigToken('A'.repeat(32), {
    secret,
    model: 'gemini-test'
  })
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'source-m17'
  )

  const events = []

  await processQueueMessage({
    v: 1,
    configToken,
    translationToken,
    configId: 'm17-config'
  }, {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: {},
    SMARTSUBS_CACHE_VERSION: 'm17-test',
    QUEUE_PARALLEL_CHUNK_ITEMS: '160',
    QUEUE_PARALLEL_CHUNK_CHARS: '20000',
    QUEUE_PARALLEL_CONCURRENCY: '3'
  }, {
    attempts: 1,
    diagnosticFn: async (_kv, _configId, event) => {
      events.push(event)
      return true
    },
    getOrTranslateFn: async options => ({
      vtt: 'WEBVTT\n',
      cacheKey: 'a'.repeat(64),
      status: 'MISS',
      translationStats: {
        expected: 650,
        received: 650,
        missing: 0,
        retryRecovered: 0,
        fallbackCount: 0,
        final: 650,
        semanticRetriesUsed: 0,
        chunks: 5,
        geminiCalls: 5,
        rateLimits: 0,
        transientRetries: 0,
        retryWaitMs: 0,
        chunkItems: options.translateOptions.maxItems,
        chunkChars: options.translateOptions.maxChars,
        concurrency: options.translateOptions.concurrency
      }
    })
  })

  assert.equal(events[0].event, 'queue-translation-start')
  assert.equal(events[0].profile, 'parallel-3')
  assert.equal(events[0].chunkItems, 160)
  assert.equal(events[0].chunkChars, 20000)
  assert.equal(events[0].concurrency, 3)

  const completed = events.find(event => event.event === 'queue-translation-complete')
  assert.equal(completed.profile, 'parallel-3')
  assert.equal(completed.chunks, 5)
  assert.equal(completed.concurrency, 3)
})
