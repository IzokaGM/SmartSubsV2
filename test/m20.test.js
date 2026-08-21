'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { translateCues } = require('../src/translator')
const { createTranslationToken } = require('../src/token')

function cue(i) {
  return {
    time: `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:59.000`,
    text: `line-${i}`
  }
}

test('M20 final stable Queue profile uses six smaller chunks for 857 cues', async () => {
  const cues = Array.from({ length: 857 }, (_, i) => cue(i))
  let calls = 0
  let maxActive = 0
  let active = 0
  let stats

  const output = await translateCues(cues, {
    maxItems: 160,
    maxChars: 20000,
    concurrency: 3,
    translateTextsFn: async (texts, options) => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 3))
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

  assert.equal(calls, 6)
  assert.equal(maxActive, 3)
  assert.equal(output.length, 857)
  assert.equal(output[0].text, 'BM:line-0')
  assert.equal(output[856].text, 'BM:line-856')
  assert.equal(stats.chunks, 6)
  assert.equal(stats.chunkItems, 160)
  assert.equal(stats.chunkChars, 20000)
  assert.equal(stats.concurrency, 3)
  assert.equal(stats.final, 857)
  assert.equal(stats.fallbackCount, 0)
})

test('M20 production selects quota-safe final profile and preserves retry fallback', async () => {
  const { queueTranslationOptions, queueFinalEnabled } = await import('../src/cloudflare-worker.mjs')

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

  assert.equal(queueFinalEnabled(env, 1), true)
  assert.equal(queueFinalEnabled(env, 2), false)

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

test('M20 rate limiter allows, blocks and fails open safely', async () => {
  const { rateLimitAllowed } = await import('../src/cloudflare-worker.mjs')

  assert.equal(await rateLimitAllowed(null, 'x'), true)
  assert.equal(await rateLimitAllowed({ limit: async () => ({ success: true }) }, 'x'), true)
  assert.equal(await rateLimitAllowed({ limit: async () => ({ success: false }) }, 'x'), false)
  assert.equal(await rateLimitAllowed({ limit: async () => { throw new Error('binding issue') } }, 'x'), true)
})

test('M20 rate-limit response is safe and retryable', async () => {
  const { rateLimitedResponse } = await import('../src/cloudflare-worker.mjs')
  const response = rateLimitedResponse('translation generation')

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '60')
  assert.equal(response.headers.get('x-smartsubs-error'), 'request-rate-limit')
})

test('M20 security headers preserve cross-origin subtitle compatibility', async () => {
  const { handleRequest } = await import('../src/cloudflare-worker.mjs')

  const response = await handleRequest(
    new Request('https://smartsubs.example/manifest.json'),
    {}
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin')
})

test('M20 malformed configured token returns 400 instead of fatal 500', async () => {
  const { handleRequest } = await import('../src/cloudflare-worker.mjs')

  const response = await handleRequest(
    new Request('https://smartsubs.example/c/%E0%A4%A/manifest.json'),
    {}
  )

  assert.equal(response.status, 400)
})

test('M20 cached prefetch avoids KV writes and Queue sends', async () => {
  const { enqueuePrefetchTranslation } = await import('../src/cloudflare-worker.mjs')

  const secret = 'm20-secret'
  const translationToken = createTranslationToken(
    'https://example.test/source.srt',
    secret,
    'source-m20'
  )
  const cacheKey = 'a'.repeat(64)

  let puts = 0
  let sends = 0
  let diagnostics = 0

  const kv = {
    async get(key, options) {
      if (key !== cacheKey) return null
      if (options && options.type === 'json') {
        return {
          v: 1,
          cacheVersion: 'm8-v1',
          expiresAt: Date.now() + 60000,
          value: 'WEBVTT\ncached\n'
        }
      }
      return null
    },
    async put() {
      puts++
    }
  }

  const ok = await enqueuePrefetchTranslation({
    autoUrl: `https://smartsubs.example/c/x/translated/${translationToken}.vtt`,
    env: {
      SMARTSUBS_CACHE: kv,
      SMARTSUBS_CACHE_VERSION: 'm8-v1',
      SMARTSUBS_TRANSLATION_QUEUE: {
        async send() {
          sends++
        }
      }
    },
    configToken: 'opaque-config',
    configId: 'm20-config',
    cacheKey,
    diagnosticFn: async () => {
      diagnostics++
      return true
    }
  })

  assert.equal(ok, true)
  assert.equal(puts, 0)
  assert.equal(sends, 0)
  assert.equal(diagnostics, 0)
})

test('M20 publicReady requires secret, KV, Queue and limiters', async () => {
  const { publicReady } = await import('../src/cloudflare-worker.mjs')

  const complete = {
    SMARTSUBS_SECRET: 'secret',
    SMARTSUBS_CACHE: {},
    SMARTSUBS_TRANSLATION_QUEUE: {},
    SMARTSUBS_SUBTITLE_LIMITER: {},
    SMARTSUBS_GENERATE_LIMITER: {}
  }

  assert.equal(publicReady(complete), true)
  assert.equal(publicReady({ ...complete, SMARTSUBS_CACHE: null }), false)
  assert.equal(publicReady({ ...complete, SMARTSUBS_TRANSLATION_QUEUE: null }), false)
  assert.equal(publicReady({ ...complete, SMARTSUBS_GENERATE_LIMITER: null }), false)
})

test('M20 Wrangler final config is quota-safe and public-ready', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.vars.QUEUE_FINAL_CHUNK_ITEMS, '160')
  assert.equal(config.vars.QUEUE_FINAL_CHUNK_CHARS, '20000')
  assert.equal(config.vars.QUEUE_FINAL_CONCURRENCY, '3')

  assert.equal(config.vars.QUEUE_PARALLEL_CHUNK_ITEMS, '160')
  assert.equal(config.vars.QUEUE_PARALLEL_CHUNK_CHARS, '20000')
  assert.equal(config.vars.QUEUE_PARALLEL_CONCURRENCY, '3')

  assert.equal(config.vars.QUEUE_FALLBACK_CHUNK_ITEMS, '180')
  assert.equal(config.vars.QUEUE_FALLBACK_CHUNK_CHARS, '24000')
  assert.equal(config.vars.QUEUE_FALLBACK_CONCURRENCY, '2')

  assert.equal(config.queues.consumers[0].max_concurrency, 1)

  assert.deepEqual(config.ratelimits, [
    {
      name: 'SMARTSUBS_SUBTITLE_LIMITER',
      namespace_id: '9282001',
      simple: { limit: 120, period: 60 }
    },
    {
      name: 'SMARTSUBS_GENERATE_LIMITER',
      namespace_id: '9282002',
      simple: { limit: 6, period: 60 }
    }
  ])
})
