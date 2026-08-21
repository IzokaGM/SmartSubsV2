'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createTranslationToken } = require('../src/token')
const { deriveVerdict } = require('../src/diagnostics')

test('M14.1 prefetch invokes translation immediately and marks it as prefetch', async () => {
  const { prefetchTranslation } = await import('../src/cloudflare-worker.mjs')
  const secret = 'm14-1-secret'
  const token = createTranslationToken(
    'https://example.test/source-en.srt',
    secret,
    'source-recovery'
  )

  const events = []
  let translateStarted = false

  const result = await prefetchTranslation({
    autoUrl: `https://smartsubs.example/c/config/translated/${token}.vtt`,
    env: { SMARTSUBS_CACHE: {}, SMARTSUBS_CACHE_VERSION: 'm14-1-test' },
    userConfig: { apiKey: 'fake-key', model: 'gemini-test' },
    secret,
    configId: 'recovery-test',
    getOrTranslateFn: async () => {
      translateStarted = true
      assert.equal(events.at(-1).event, 'translation-request')
      assert.equal(events.at(-1).status, 'prefetch')
      return {
        vtt: 'WEBVTT\n',
        cacheKey: 'a'.repeat(64),
        status: 'MISS',
        translationStats: {
          expected: 771,
          received: 771,
          missing: 0,
          retryRecovered: 0,
          fallbackCount: 0,
          final: 771,
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

  assert.equal(translateStarted, true)
  assert.equal(result.status, 'MISS')
  assert.deepEqual(events.map(x => x.event), [
    'prefetch-start',
    'translation-request',
    'prefetch-complete'
  ])
  assert.equal(events[2].chunks, 5)
  assert.equal(events[2].concurrency, 2)
})

test('M14.1 diagnose reports PREFETCH_TRANSLATING while background work is active', () => {
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
    { ts: now + 1, event: 'translation-request', status: 'prefetch' }
  ]), 'PREFETCH_TRANSLATING')
})

test('M14.1 prefetch failure wins over its earlier request marker', () => {
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
    { ts: now + 1, event: 'translation-request', status: 'prefetch' },
    { ts: now + 2, event: 'prefetch-failed', status: 'background-failed' }
  ]), 'PREFETCH_FAILED_WAITING_FOR_PLAYER_SELECTION')
})
