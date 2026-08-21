'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createTranslationToken } = require('../src/token')
const { createUserConfigToken } = require('../src/user-config')
const { deriveVerdict } = require('../src/diagnostics')

test('M15 enqueue stores opaque tokens and no plaintext apiKey field', async () => {
  const { enqueuePrefetchTranslation } = await import('../src/cloudflare-worker.mjs')
  const secret = 'm15-secret'
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'source-m15'
  )
  const sent = []
  const events = []

  const ok = await enqueuePrefetchTranslation({
    autoUrl: `https://smartsubs.example/c/config/translated/${translationToken}.vtt`,
    env: {
      SMARTSUBS_CACHE: {},
      SMARTSUBS_TRANSLATION_QUEUE: {
        send: async body => { sent.push(body) }
      }
    },
    configToken: 'opaque-config-token',
    configId: 'config-m15',
    diagnosticFn: async (_kv, _configId, event) => {
      events.push(event)
      return true
    }
  })

  assert.equal(ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].v, 1)
  assert.equal(sent[0].configToken, 'opaque-config-token')
  assert.equal(sent[0].translationToken, translationToken)
  assert.equal(Object.hasOwn(sent[0], 'apiKey'), false)
  assert.deepEqual(events.map(x => x.event), ['queue-enqueued'])
})

test('M15 consumer decrypts BYOK only inside consumer and translates', async () => {
  const { processQueueMessage } = await import('../src/cloudflare-worker.mjs')
  const secret = 'm15-consumer-secret'
  const apiKey = 'A'.repeat(32)
  const configToken = createUserConfigToken(apiKey, {
    secret,
    model: 'gemini-test'
  })
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'source-m15-consumer'
  )

  const events = []
  let translationOptions = null

  const result = await processQueueMessage({
    v: 1,
    configToken,
    translationToken,
    configId: 'consumer-config',
    queuedAt: Date.now()
  }, {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: {},
    SMARTSUBS_CACHE_VERSION: 'm15-test'
  }, {
    attempts: 1,
    getOrTranslateFn: async options => {
      translationOptions = options
      return {
        vtt: 'WEBVTT\n',
        cacheKey: 'a'.repeat(64),
        status: 'MISS',
        translationStats: {
          expected: 830,
          received: 830,
          missing: 0,
          retryRecovered: 0,
          fallbackCount: 0,
          final: 830,
          semanticRetriesUsed: 0,
          chunks: 5,
          geminiCalls: 5,
          rateLimits: 0,
          transientRetries: 0,
          retryWaitMs: 0,
          chunkItems: 180,
          chunkChars: 24000,
          concurrency: 2
        }
      }
    },
    diagnosticFn: async (_kv, _configId, event) => {
      events.push(event)
      return true
    }
  })

  assert.equal(result.status, 'MISS')
  assert.equal(translationOptions.apiKey, apiKey)
  assert.equal(translationOptions.model, 'gemini-test')
  assert.equal(translationOptions.upstreamUrl, 'https://example.test/source.srt')
  assert.deepEqual(events.map(x => x.event), [
    'queue-translation-start',
    'queue-translation-complete'
  ])
  assert.equal(events[1].chunks, 5)
  assert.equal(events[1].concurrency, 2)
})

test('M15 handler acknowledges success and retries transient failure', async () => {
  const { handleQueue } = await import('../src/cloudflare-worker.mjs')

  let acked = 0
  const retried = []

  const success = {
    body: { id: 1 },
    attempts: 1,
    ack() { acked++ },
    retry(options) { retried.push(options) }
  }

  const transient = {
    body: { id: 2 },
    attempts: 2,
    ack() { acked++ },
    retry(options) { retried.push(options) }
  }

  await handleQueue({
    messages: [success, transient]
  }, {}, {
    processFn: async body => {
      if (body.id === 2) throw new Error('Gemini HTTP 429')
      return true
    }
  })

  assert.equal(acked, 1)
  assert.deepEqual(retried, [{ delaySeconds: 20 }])
})

test('M15 Wrangler config serializes translation queue consumer', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))
  assert.deepEqual(config.queues.producers, [{
    binding: 'SMARTSUBS_TRANSLATION_QUEUE',
    queue: 'smartsubs-translation'
  }])
  assert.equal(config.queues.consumers[0].queue, 'smartsubs-translation')
  assert.equal(config.queues.consumers[0].max_batch_size, 1)
  assert.equal(config.queues.consumers[0].max_concurrency, 1)
})

test('M15 diagnose recognises queue lifecycle before player selection', () => {
  const now = Date.now()
  const subtitle = {
    ts: now,
    event: 'subtitle-result',
    result: 'auto-malay-ready',
    subtitleCount: 1,
    englishFound: true,
    byokConfigured: true,
    autoReady: true
  }

  assert.equal(deriveVerdict([
    subtitle,
    { ts: now + 1, event: 'queue-enqueued', status: 'queued' }
  ]), 'QUEUE_PREFETCH_QUEUED')

  assert.equal(deriveVerdict([
    subtitle,
    { ts: now + 1, event: 'queue-enqueued', status: 'queued' },
    { ts: now + 2, event: 'queue-translation-start', status: 'consumer' }
  ]), 'QUEUE_PREFETCH_TRANSLATING')

  assert.equal(deriveVerdict([
    subtitle,
    { ts: now + 1, event: 'queue-enqueued', status: 'queued' },
    { ts: now + 2, event: 'queue-translation-start', status: 'consumer' },
    { ts: now + 50000, event: 'queue-translation-complete', cache: 'MISS', totalMs: 49800 }
  ]), 'QUEUE_PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION')
})
