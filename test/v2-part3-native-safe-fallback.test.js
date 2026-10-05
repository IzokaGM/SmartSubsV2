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

test('Native Malay does not suppress Malay AI; prefetch retains existing native policy', async () => {
  for (const [nativeId, url] of [['native-weak','https://example.test/native.srt'],
      ['native-strong','https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.srt']]) {
    const events=[]
    const result=await handleSubtitles({type:'series',id:'tt10986410:1:1',extra:{filename:'Show.WEB-DL.mkv'}},
      {apiKey:'test-key',publicBaseUrl:'https://smartsubs.example/c/test',tokenSecret:'test-secret',
      fetchImpl:responseFor([{id:nativeId,lang:'ms',url},
        {id:'english',lang:'eng',url:'https://example.test/english.srt'}]),
      onDiagnostic:async e=>events.push(e)})
    assert.equal(result.subtitles.length,2)
    assert.equal(result.subtitles[0].id,nativeId)
    assert.match(result.subtitles[1].id,/^gemini-ai-/)
    assert.equal(result.autoPrefetch,false)
    const event=events.find(e=>e.event==='subtitle-result')
    assert.equal(event.autoReady,true)
    assert.equal('nativeConfidence' in event,false)
  }
})

test('No native Malay retains automatic prefetch', async () => {
  const result=await handleSubtitles({type:'movie',id:'tt1375666',extra:{}},
    {apiKey:'test-key',publicBaseUrl:'https://smartsubs.example/c/test',tokenSecret:'test-secret',
     fetchImpl:responseFor([{id:'english',lang:'eng',url:'https://example.test/english.srt'}])})
  assert.equal(result.subtitles.length,1)
  assert.equal(result.autoPrefetch,true)
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
      'https://smartsubs.example/c/test/translated/token.vtt'
    ),
    false
  )

  assert.equal(
    shouldPrefetchAutoResult(
      { autoPrefetch: true },
      'https://smartsubs.example/c/test/translated/token.vtt'
    ),
    true
  )
})
