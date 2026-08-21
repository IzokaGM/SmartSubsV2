'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createTranslationToken, decodeTranslationTokenData } = require('../src/token')
const { createUserConfigToken } = require('../src/user-config')
const { deriveVerdict } = require('../src/diagnostics')

function fakeKv() {
  const values = new Map()
  return {
    values,
    async get(key, options) {
      const raw = values.get(key)
      if (raw == null) return null
      if (options && options.type === 'json') return JSON.parse(raw)
      return raw
    },
    async put(key, value) {
      values.set(key, String(value))
    },
    async delete(key) {
      values.delete(key)
    }
  }
}

test('M16 cf-cache forwards queue-only translation options safely', async () => {
  const { cfGetOrTranslate } = await import('../src/cf-cache.mjs')
  let received = null
  const cache = {
    version: 'm8-v1',
    async get() { return null },
    async set() {}
  }

  const result = await cfGetOrTranslate({
    cache,
    upstreamUrl: 'https://example.test/source.srt',
    sourceId: 'source-m16',
    model: 'gemini-test',
    apiKey: 'secret-key',
    cacheVersion: 'm8-v1',
    translateOptions: {
      maxItems: 240,
      maxChars: 30000,
      concurrency: 2
    },
    translateFn: async (_url, options) => {
      received = options
      await options.onTranslationStats({
        expected: 1,
        received: 1,
        missing: 0,
        retryRecovered: 0,
        fallbackCount: 0,
        final: 1
      })
      return 'WEBVTT\n'
    }
  })

  assert.equal(result.status, 'MISS')
  assert.equal(received.maxItems, 240)
  assert.equal(received.maxChars, 30000)
  assert.equal(received.concurrency, 2)
  assert.equal(received.apiKey, 'secret-key')
  assert.equal(received.model, 'gemini-test')
})

test('M16 queue consumer uses conservative 240 cue speed profile and marks job ready', async () => {
  const {
    processQueueMessage,
    translationCacheKey,
    readQueueJobState
  } = await import('../src/cloudflare-worker.mjs')

  const secret = 'm16-consumer-secret'
  const apiKey = 'A'.repeat(32)
  const kv = fakeKv()
  const configToken = createUserConfigToken(apiKey, {
    secret,
    model: 'gemini-test'
  })
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'source-m16-consumer'
  )
  const tokenData = decodeTranslationTokenData(translationToken, secret)
  const env = {
    SMARTSUBS_SECRET: secret,
    SMARTSUBS_CACHE: kv,
    SMARTSUBS_CACHE_VERSION: 'm8-v1',
    QUEUE_TRANSLATION_CHUNK_ITEMS: '240',
    QUEUE_TRANSLATION_CHUNK_CHARS: '30000',
    QUEUE_TRANSLATION_CONCURRENCY: '2'
  }
  const cacheKey = translationCacheKey(tokenData, 'gemini-test', env)
  let optionsSeen = null

  const result = await processQueueMessage({
    v: 1,
    configToken,
    translationToken,
    configId: 'm16-config',
    cacheKey
  }, env, {
    attempts: 1,
    diagnosticFn: async () => true,
    getOrTranslateFn: async options => {
      optionsSeen = options
      return {
        vtt: 'WEBVTT\n',
        cacheKey,
        status: 'MISS',
        translationStats: {
          expected: 903,
          received: 903,
          missing: 0,
          retryRecovered: 0,
          fallbackCount: 0,
          final: 903,
          semanticRetriesUsed: 0,
          chunks: 4,
          geminiCalls: 4,
          rateLimits: 0,
          transientRetries: 0,
          retryWaitMs: 0,
          chunkItems: 240,
          chunkChars: 30000,
          concurrency: 2
        }
      }
    }
  })

  assert.equal(result.status, 'MISS')
  assert.deepEqual(optionsSeen.translateOptions, {
    maxItems: 240,
    maxChars: 30000,
    concurrency: 2
  })
  const job = await readQueueJobState(env, cacheKey)
  assert.equal(job.state, 'ready')
})

test('M16 Queue Join waits for existing Queue result instead of translating again', async () => {
  const {
    waitForQueueCache,
    writeQueueJobState
  } = await import('../src/cloudflare-worker.mjs')

  const kv = fakeKv()
  const env = {
    SMARTSUBS_CACHE: kv,
    QUEUE_JOIN_MAX_MS: '10000',
    QUEUE_JOIN_POLL_MS: '1000'
  }
  const cacheKey = 'a'.repeat(64)

  await writeQueueJobState(env, cacheKey, {
    state: 'running',
    configId: 'join-test',
    attempts: 1
  })

  let cacheReads = 0
  let now = 0
  const cache = {
    async get() {
      cacheReads++
      return cacheReads >= 3 ? 'WEBVTT\njoined\n' : null
    }
  }

  const joined = await waitForQueueCache({
    env,
    cache,
    cacheKey,
    nowFn: () => now,
    sleepFn: async ms => { now += ms },
    maxWaitMs: 10000,
    pollMs: 1000
  })

  assert.equal(joined.outcome, 'hit')
  assert.equal(joined.vtt, 'WEBVTT\njoined\n')
  assert.equal(joined.waitMs, 3000)
  assert.equal(joined.polls, 3)
})

test('M16 enqueue dedupes a running Queue job', async () => {
  const {
    enqueuePrefetchTranslation,
    writeQueueJobState
  } = await import('../src/cloudflare-worker.mjs')

  const secret = 'm16-enqueue-secret'
  const kv = fakeKv()
  const cacheKey = 'b'.repeat(64)
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'source-dedupe'
  )
  let sends = 0
  const events = []

  const env = {
    SMARTSUBS_CACHE: kv,
    SMARTSUBS_TRANSLATION_QUEUE: {
      async send() { sends++ }
    }
  }

  await writeQueueJobState(env, cacheKey, {
    state: 'running',
    configId: 'dedupe-test',
    attempts: 1
  })

  const ok = await enqueuePrefetchTranslation({
    autoUrl: `https://smartsubs.example/c/x/translated/${translationToken}.vtt`,
    env,
    configToken: 'opaque-config',
    configId: 'dedupe-test',
    cacheKey,
    diagnosticFn: async (_kv, _id, event) => {
      events.push(event)
      return true
    }
  })

  assert.equal(ok, true)
  assert.equal(sends, 0)
  assert.equal(events.at(-1).event, 'queue-deduped')
  assert.equal(events.at(-1).status, 'running')
})

test('M16 diagnose reports Queue Join waiting state', () => {
  const now = Date.now()

  assert.equal(deriveVerdict([
    {
      ts: now,
      event: 'subtitle-result',
      result: 'auto-malay-ready',
      subtitleCount: 1,
      englishFound: true,
      byokConfigured: true,
      autoReady: true
    },
    {
      ts: now + 1,
      event: 'translation-request',
      status: 'player'
    },
    {
      ts: now + 2,
      event: 'queue-join-start',
      status: 'running'
    }
  ]), 'QUEUE_JOIN_WAITING')
})

test('M16 Wrangler keeps player defaults stable and tunes Queue only', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.TRANSLATION_CHUNK_ITEMS, '180')
  assert.equal(config.vars.TRANSLATION_CHUNK_CHARS, '24000')
  assert.equal(config.vars.TRANSLATION_CONCURRENCY, '2')

  assert.equal(config.vars.QUEUE_TRANSLATION_CHUNK_ITEMS, '240')
  assert.equal(config.vars.QUEUE_TRANSLATION_CHUNK_CHARS, '30000')
  assert.equal(config.vars.QUEUE_TRANSLATION_CONCURRENCY, '2')
  assert.equal(config.vars.QUEUE_JOIN_MAX_MS, '55000')
  assert.equal(config.vars.QUEUE_JOIN_POLL_MS, '1500')
})
