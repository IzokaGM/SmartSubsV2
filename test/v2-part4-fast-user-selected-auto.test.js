'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { translateCues } = require('../src/translator')
const { createTranslationToken } = require('../src/token')
const { createUserConfigToken } = require('../src/user-config')

function cue(i) {
  return {
    time: `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:59.000`,
    text: `line-${i}`
  }
}

test('Part 4.1 caps explicit translation concurrency at stable value three', async () => {
  const cues = Array.from({ length: 653 }, (_, i) => cue(i))
  let active = 0
  let maxActive = 0
  let calls = 0
  let stats

  const output = await translateCues(cues, {
    maxItems: 160,
    maxChars: 20000,
    concurrency: 4,
    translateTextsFn: async (texts, options) => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 4))
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
  assert.equal(output.length, 653)
  assert.equal(stats.chunks, 5)
  assert.equal(stats.concurrency, 3)
  assert.equal(stats.chunkItems, 160)
  assert.equal(stats.chunkChars, 20000)
})

test('Part 4 user-selected Queue gets fast profile only on first attempt', async () => {
  const {
    queueTranslationOptions,
    queueTranslationProfile
  } = await import('../src/cloudflare-worker.mjs')

  const env = {
    QUEUE_USER_SELECTED_CHUNK_ITEMS: '160',
    QUEUE_USER_SELECTED_CHUNK_CHARS: '20000',
    QUEUE_USER_SELECTED_CONCURRENCY: '3',
    QUEUE_FINAL_CHUNK_ITEMS: '160',
    QUEUE_FINAL_CHUNK_CHARS: '20000',
    QUEUE_FINAL_CONCURRENCY: '3',
    QUEUE_FALLBACK_CHUNK_ITEMS: '180',
    QUEUE_FALLBACK_CHUNK_CHARS: '24000',
    QUEUE_FALLBACK_CONCURRENCY: '2'
  }

  assert.equal(
    queueTranslationProfile(env, 1, 'user-selected-stable'),
    'user-selected-stable'
  )
  assert.deepEqual(
    queueTranslationOptions(env, 1, 'user-selected-stable'),
    { maxItems: 160, maxChars: 20000, concurrency: 3 }
  )

  assert.equal(
    queueTranslationProfile(env, 2, 'user-selected-stable'),
    'fallback-stable'
  )
  assert.deepEqual(
    queueTranslationOptions(env, 2, 'user-selected-stable'),
    { maxItems: 180, maxChars: 24000, concurrency: 2 }
  )
})

test('Part 4 background Queue profile remains unchanged', async () => {
  const {
    queueTranslationOptions,
    queueTranslationProfile
  } = await import('../src/cloudflare-worker.mjs')

  const env = {
    QUEUE_FINAL_CHUNK_ITEMS: '160',
    QUEUE_FINAL_CHUNK_CHARS: '20000',
    QUEUE_FINAL_CONCURRENCY: '3',
    QUEUE_FALLBACK_CHUNK_ITEMS: '180',
    QUEUE_FALLBACK_CHUNK_CHARS: '24000',
    QUEUE_FALLBACK_CONCURRENCY: '2'
  }

  assert.equal(queueTranslationProfile(env, 1), 'quota-safe-final')
  assert.deepEqual(
    queueTranslationOptions(env, 1),
    { maxItems: 160, maxChars: 20000, concurrency: 3 }
  )
})

test('Part 4 enqueue serialises only the approved user-selected profile', async () => {
  const { enqueuePrefetchTranslation } = await import('../src/cloudflare-worker.mjs')

  const secret = 'part4-secret'
  const configToken = createUserConfigToken('A'.repeat(32), {
    secret,
    model: 'gemini-test'
  })
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'part4-source'
  )

  let sent = null
  const ok = await enqueuePrefetchTranslation({
    autoUrl: `https://smartsubsv2.example/c/x/translated/${translationToken}.vtt`,
    env: {
      SMARTSUBS_TRANSLATION_QUEUE: {
        async send(body) {
          sent = body
        }
      }
    },
    configToken,
    configId: 'part4-config',
    cacheKey: '',
    queueProfile: 'user-selected-stable',
    diagnosticFn: async () => true
  })

  assert.equal(ok, true)
  assert.equal(sent.profile, 'user-selected-stable')
})

test('Part 4 Queue consumer exposes fast profile in Diagnose and translation options', async () => {
  const { processQueueMessage } = await import('../src/cloudflare-worker.mjs')

  const secret = 'part4-consumer-secret'
  const configToken = createUserConfigToken('B'.repeat(32), {
    secret,
    model: 'gemini-test'
  })
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'part4-consumer-source'
  )

  const events = []
  let translateOptions = null

  await processQueueMessage({
    v: 1,
    configToken,
    translationToken,
    configId: 'part4-consumer',
    profile: 'user-selected-stable'
  }, {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: {},
    SMARTSUBS_CACHE_VERSION: 'part4',
    QUEUE_USER_SELECTED_CHUNK_ITEMS: '160',
    QUEUE_USER_SELECTED_CHUNK_CHARS: '20000',
    QUEUE_USER_SELECTED_CONCURRENCY: '3',
    QUEUE_FALLBACK_CHUNK_ITEMS: '180',
    QUEUE_FALLBACK_CHUNK_CHARS: '24000',
    QUEUE_FALLBACK_CONCURRENCY: '2'
  }, {
    attempts: 1,
    diagnosticFn: async (_kv, _configId, event) => {
      events.push(event)
      return true
    },
    getOrTranslateFn: async options => {
      translateOptions = options.translateOptions
      return {
        vtt: 'WEBVTT\n',
        cacheKey: 'a'.repeat(64),
        status: 'MISS',
        translationStats: {
          expected: 653,
          received: 653,
          missing: 0,
          retryRecovered: 0,
          fallbackCount: 0,
          final: 653,
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
      }
    }
  })

  assert.deepEqual(
    translateOptions,
    { maxItems: 160, maxChars: 20000, concurrency: 3 }
  )

  const started = events.find(event => event.event === 'queue-translation-start')
  const completed = events.find(event => event.event === 'queue-translation-complete')

  assert.equal(started.profile, 'user-selected-stable')
  assert.equal(started.concurrency, 3)
  assert.equal(completed.profile, 'user-selected-stable')
  assert.equal(completed.concurrency, 3)
})

test('Part 4 selected translated route explicitly requests fast profile', () => {
  const source = fs.readFileSync('src/cloudflare-worker.mjs', 'utf8')
  const routeStart = source.indexOf("const translationMatch =")
  const routeEnd = source.indexOf("if (request.method === 'GET')", routeStart)
  const route = source.slice(routeStart, routeEnd)

  assert.match(route, /queueProfile: 'user-selected-stable'/)
})

test('Part 4 Wrangler keeps background profile and adds isolated fast profile', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.QUEUE_FINAL_CONCURRENCY, '3')
  assert.equal(config.vars.QUEUE_USER_SELECTED_CHUNK_ITEMS, '160')
  assert.equal(config.vars.QUEUE_USER_SELECTED_CHUNK_CHARS, '20000')
  assert.equal(config.vars.QUEUE_USER_SELECTED_CONCURRENCY, '3')
  assert.equal(config.queues.consumers[0].max_concurrency, 1)
})
