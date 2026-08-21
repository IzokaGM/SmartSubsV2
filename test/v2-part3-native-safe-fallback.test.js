'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  subtitleMatchConfidence,
  rankMalaySubtitles
} = require('../src/selector')
const { handleSubtitles } = require('../src/subtitles')
const { sanitiseEvent, deriveVerdict } = require('../src/diagnostics')

function responseFor(subtitles) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ subtitles })
  })
}

test('Part 3 treats a 10020 base-style native Malay score as weak evidence', () => {
  const subtitle = {
    id: 'native-only',
    lang: 'ms',
    url: 'https://example.test/native.srt'
  }

  const info = subtitleMatchConfidence(
    subtitle,
    0,
    { filename: 'Ted Lasso Season 1 (2020) S01E01-onetouchtv' },
    10020
  )

  assert.equal(info.level, 'WEAK')
  assert.equal(info.reason, 'insufficient-sync-evidence')
  assert.equal(info.scoreUplift, 20)
})

test('Part 3 recognises strong native release evidence', () => {
  const ranked = rankMalaySubtitles([{
    id: 'native-match',
    lang: 'ms',
    url: 'https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.srt'
  }], {
    filename: 'Show.S01E01.1080p.WEB-DL.x265-GROUP.mkv'
  })

  assert.equal(ranked[0].confidence.level, 'STRONG')
  assert.ok(ranked[0].confidence.scoreUplift >= 700)
})

test('Part 3 weak native Malay offers Auto but disables background Gemini prefetch', async () => {
  const upstream = [
    {
      id: 'native-weak',
      lang: 'ms',
      url: 'https://example.test/native.srt'
    },
    {
      id: 'english-weak',
      lang: 'eng',
      url: 'https://example.test/english.srt'
    }
  ]

  const events = []
  const result = await handleSubtitles({
    type: 'series',
    id: 'tt10986410:1:1',
    extra: { filename: 'Ted Lasso Season 1 (2020) S01E01-onetouchtv' }
  }, {
    apiKey: 'test-key',
    publicBaseUrl: 'https://smartsubsv2.example/c/test',
    tokenSecret: 'test-secret',
    fetchImpl: responseFor(upstream),
    onDiagnostic: async event => events.push(event)
  })

  assert.equal(result.subtitles.length, 2)
  assert.equal(result.subtitles[0].id, 'native-weak')
  assert.match(result.subtitles[1].id, /^smartsubs-auto-/)
  assert.equal(result.autoPrefetch, false)
  assert.equal(result.autoPrefetchReason, 'weak-native-wait-for-user-selection')

  const event = events.find(item => item.event === 'subtitle-result')
  assert.ok(event)
  assert.equal(event.result, 'native-malay-with-auto-fallback')
  assert.equal(event.nativeConfidence, 'WEAK')
  assert.equal(event.nativeDecision, 'dual-fallback')
  assert.equal(event.autoFallbackOffered, true)
  assert.equal(event.autoPrefetch, false)
  assert.equal(event.geminiPrefetchAvoided, true)
})

test('Part 3 strong native Malay remains native-only', async () => {
  const upstream = [
    {
      id: 'native-strong',
      lang: 'ms',
      url: 'https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.srt'
    },
    {
      id: 'english',
      lang: 'eng',
      url: 'https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.en.srt'
    }
  ]

  const events = []
  const result = await handleSubtitles({
    type: 'series',
    id: 'tt123:1:1',
    extra: { filename: 'Show.S01E01.1080p.WEB-DL.x265-GROUP.mkv' }
  }, {
    apiKey: 'test-key',
    publicBaseUrl: 'https://smartsubsv2.example/c/test',
    tokenSecret: 'test-secret',
    fetchImpl: responseFor(upstream),
    onDiagnostic: async event => events.push(event)
  })

  assert.equal(result.subtitles.length, 1)
  assert.equal(result.subtitles[0].id, 'native-strong')
  assert.equal(result.autoPrefetch, false)

  const event = events.find(item => item.event === 'subtitle-result')
  assert.equal(event.result, 'native-malay')
  assert.equal(event.nativeConfidence, 'STRONG')
  assert.equal(event.nativeDecision, 'native-only-strong')
  assert.equal(event.autoFallbackOffered, false)
  assert.equal(event.geminiPrefetchAvoided, true)
})

test('Part 3 no-native path keeps existing aggressive Auto pretranslation', async () => {
  const events = []
  const result = await handleSubtitles({
    type: 'movie',
    id: 'tt1375666',
    extra: {}
  }, {
    apiKey: 'test-key',
    publicBaseUrl: 'https://smartsubsv2.example/c/test',
    tokenSecret: 'test-secret',
    fetchImpl: responseFor([{
      id: 'english-only',
      lang: 'eng',
      url: 'https://example.test/english.srt'
    }]),
    onDiagnostic: async event => events.push(event)
  })

  assert.equal(result.subtitles.length, 1)
  assert.equal(result.autoPrefetch, true)
  assert.equal(result.autoPrefetchReason, 'no-native-malay-aggressive-prefetch')

  const event = events.find(item => item.event === 'subtitle-result')
  assert.equal(event.nativeDecision, 'no-native-malay')
  assert.equal(event.autoPrefetch, true)
  assert.equal(event.geminiPrefetchAvoided, false)
})

test('Part 3 Diagnose preserves native decision and quota fields', () => {
  const clean = sanitiseEvent({
    event: 'subtitle-result',
    nativeConfidence: 'WEAK',
    nativeConfidenceReason: 'insufficient-sync-evidence',
    nativeScoreUplift: 20,
    nativeDecision: 'dual-fallback',
    autoFallbackOffered: true,
    autoPrefetch: false,
    autoPrefetchReason: 'weak-native-wait-for-user-selection',
    geminiPrefetchAvoided: true,
    englishConfidence: 'WEAK',
    englishConfidenceReason: 'insufficient-sync-evidence',
    englishScoreUplift: 20
  })

  assert.equal(clean.nativeConfidence, 'WEAK')
  assert.equal(clean.nativeDecision, 'dual-fallback')
  assert.equal(clean.autoFallbackOffered, true)
  assert.equal(clean.autoPrefetch, false)
  assert.equal(clean.geminiPrefetchAvoided, true)
  assert.equal(clean.englishConfidence, 'WEAK')
})

test('Part 3 dual fallback gets a dedicated Diagnose verdict', () => {
  assert.equal(
    deriveVerdict([{
      ts: Date.now(),
      event: 'subtitle-result',
      result: 'native-malay-with-auto-fallback',
      subtitleCount: 2,
      autoReady: true
    }]),
    'NATIVE_MALAY_WITH_AUTO_FALLBACK'
  )
})

test('Part 3 Worker prefetch policy protects Gemini until Auto is selected', async () => {
  const { shouldPrefetchAutoResult } = await import('../src/cloudflare-worker.mjs')

  assert.equal(
    shouldPrefetchAutoResult(
      { autoPrefetch: false },
      'https://smartsubsv2.example/c/test/translated/token.vtt'
    ),
    false
  )

  assert.equal(
    shouldPrefetchAutoResult(
      { autoPrefetch: true },
      'https://smartsubsv2.example/c/test/translated/token.vtt'
    ),
    true
  )
})
