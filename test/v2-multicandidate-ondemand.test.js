
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { handleSubtitles } = require('../src/subtitles')
const { decodeTranslationTokenData } = require('../src/token')

function translationTokenFromUrl(url) {
  const match = String(url).match(/\/translated\/([A-Za-z0-9_.-]+)\.vtt$/)
  return match && match[1]
}

test('V2 exposes up to five eligible English candidates as on-demand Malay AI tracks', async () => {
  const english = Array.from({ length: 7 }, (_, index) => ({
    id: `source-${index + 1}`,
    lang: index % 2 ? 'en' : 'eng',
    url: `https://example.test/source-${index + 1}.srt`
  }))
  let upstreamFetches = 0
  const events = []
  const result = await handleSubtitles({ type: 'movie', id: 'tt1234567', extra: {} }, {
    apiKey: 'test-key',
    publicBaseUrl: 'https://smartsubsv2.example/c/test',
    tokenSecret: 'test-secret',
    includeEnglishTracks: true,
    fetchImpl: async () => {
      upstreamFetches++
      return {
        ok: true,
        status: 200,
        json: async () => ({ subtitles: [
          ...english,
          { id: 'duplicate', lang: 'eng', url: english[0].url },
          { id: 'bad', lang: 'eng' }
        ] })
      }
    },
    onDiagnostic: async event => events.push(event)
  })

  const ai = result.subtitles.filter(item => item.lang === 'msa')
  const rawEnglish = result.subtitles.filter(item => item.lang === 'eng')

  assert.equal(upstreamFetches, 1)
  assert.equal(ai.length, 5)
  assert.equal(rawEnglish.length, 5) // Both AI and raw English have independent five-track caps.
  assert.deepEqual(ai.map(item => item.id), english.slice(0, 5).map(item => `gemini-ai-${item.id}`))
  assert.equal(new Set(ai.map(item => item.url)).size, 5)
  assert.equal(result.autoPrefetch, false)
  assert.equal(result.autoPrefetchReason, 'on-demand-candidate-selection')

  const tokenData = ai.map(item => decodeTranslationTokenData(translationTokenFromUrl(item.url), 'test-secret'))
  assert.deepEqual(tokenData.map(item => item.sourceId), english.slice(0, 5).map(item => item.id))
  assert.deepEqual(tokenData.map(item => item.url), english.slice(0, 5).map(item => item.url))

  const event = events.find(item => item.event === 'subtitle-result')
  assert.equal(event.aiCandidateCount, 5)
  assert.equal(event.englishCandidateCount, 7)
  assert.equal(event.englishTrackCount, 5)
  assert.equal(event.englishSelectedId, '')
})

test('V2 subtitle-list route never enqueues background translation', async () => {
  const { shouldPrefetchAutoResult } = await import('../src/cloudflare-worker.mjs')
  assert.equal(shouldPrefetchAutoResult({ autoPrefetch: true }, 'https://example.test/translated/a.vtt'), false)

  const source = fs.readFileSync('src/cloudflare-worker.mjs', 'utf8')
  const start = source.indexOf("const aiCandidateCount = Number(result?.aiCandidateCount || 0)")
  const end = source.indexOf('return json(result, 200', start)
  const subtitleListTail = source.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.doesNotMatch(subtitleListTail, /enqueuePrefetchTranslation\s*\(/)
  assert.match(subtitleListTail, /auto-prefetch-skipped/)
})

test('V2 caps deduplicated Native Malay candidates at five tracks', async () => {
  const malay = Array.from({ length: 7 }, (_, index) => ({
    id: `malay-${index + 1}`,
    lang: index % 2 ? 'ms' : 'msa',
    url: `https://example.test/malay-${index + 1}.srt`
  }))
  const events = []
  const result = await handleSubtitles({ type: 'movie', id: 'tt7654321', extra: {} }, {
    includeEnglishTracks: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ subtitles: [
        ...malay,
        { id: 'malay-copy', lang: malay[0].lang, url: malay[0].url }
      ] })
    }),
    onDiagnostic: async event => events.push(event)
  })

  assert.equal(result.subtitles.length, 5)
  assert.deepEqual(result.subtitles.map(item => item.url), malay.slice(0, 5).map(item => item.url))
  assert.equal(new Set(result.subtitles.map(item => item.url)).size, 5)

  const event = events.find(item => item.event === 'subtitle-result')
  assert.equal(event.malayCount, 5)
  assert.equal(event.subtitleCount, 5)
})
