'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createTranslationToken } = require('../src/token')
const { deriveVerdict } = require('../src/diagnostics')

test('M13 background prefetch decodes auto subtitle token and warms translation cache', async () => {
  const { prefetchTranslation } = await import('../src/cloudflare-worker.mjs')
  const secret = 'm13-secret'
  const token = createTranslationToken(
    'https://example.test/source-en.srt',
    secret,
    'source-123'
  )
  const events = []
  const calls = []

  const result = await prefetchTranslation({
    autoUrl: `https://smartsubs.example/c/config/translated/${token}.vtt`,
    env: {
      SMARTSUBS_CACHE: {},
      SMARTSUBS_CACHE_VERSION: 'm13-test'
    },
    userConfig: {
      apiKey: 'fake-gemini-key',
      model: 'gemini-test'
    },
    secret,
    configId: 'config-test',
    getOrTranslateFn: async options => {
      calls.push(options)
      return {
        vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHai\n',
        cacheKey: 'a'.repeat(64),
        status: 'MISS',
        translationStats: null
      }
    },
    diagnosticFn: async (_kv, _configId, event) => {
      events.push(event)
      return true
    }
  })

  assert.equal(result.status, 'MISS')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].upstreamUrl, 'https://example.test/source-en.srt')
  assert.equal(calls[0].sourceId, 'source-123')
  assert.deepEqual(events.map(item => item.event), ['prefetch-start', 'translation-request', 'prefetch-complete'])
  assert.equal(events[1].status, 'prefetch')
  assert.equal(events[2].status, 'ready')
})

test('M13 background prefetch failure never throws into subtitle list response path', async () => {
  const { prefetchTranslation } = await import('../src/cloudflare-worker.mjs')
  const secret = 'm13-secret'
  const token = createTranslationToken('https://example.test/source-en.srt', secret, 'source-123')
  const events = []

  const result = await prefetchTranslation({
    autoUrl: `https://smartsubs.example/c/config/translated/${token}.vtt`,
    env: { SMARTSUBS_CACHE: {} },
    userConfig: { apiKey: 'fake-gemini-key', model: 'gemini-test' },
    secret,
    configId: 'config-test',
    getOrTranslateFn: async () => { throw new Error('background test failure') },
    diagnosticFn: async (_kv, _configId, event) => {
      events.push(event)
      return true
    }
  })

  assert.equal(result, null)
  assert.deepEqual(events.map(item => item.event), ['prefetch-start', 'translation-request', 'prefetch-failed'])
})

test('M13 diagnose reports cached prefetch ready before player selection', () => {
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
      event: 'prefetch-complete',
      status: 'ready',
      cache: 'MISS'
    }
  ]), 'PREFETCH_READY_WAITING_FOR_PLAYER_SELECTION')
})

test('M13 diagnose preserves normal translation-delivered precedence', () => {
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
    { ts: now + 1, event: 'prefetch-complete', status: 'ready' },
    { ts: now + 2, event: 'translation-request' },
    { ts: now + 3, event: 'translation-delivered', cache: 'HIT' }
  ]), 'TRANSLATION_DELIVERED')
})
