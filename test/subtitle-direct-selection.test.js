'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { handleSubtitles } = require('../src/subtitles')
const { sanitiseEvent } = require('../src/diagnostics')

const native = { id: 'ms-1', lang: 'ms', url: 'https://example.test/native.srt' }
const first = { id: 'en-1', lang: 'eng', url: 'https://example.test/release-1.srt' }
const second = { id: 'en-2', lang: 'en', url: 'https://example.test/release-2.srt' }
function options(subtitles, onDiagnostic = () => {}) {
  return { apiKey: 'test-key', publicBaseUrl: 'https://smartsubs.example/c/config',
    tokenSecret: 'test-secret', includeEnglishTracks: true, onDiagnostic,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ subtitles }) }) }
}
const args = { type: 'series', id: 'tt1234567:1:1', extra: { filename: 'release-2.mkv', videoHash: 'hash' } }

test('every eligible English source gets an on-demand Malay AI track without preselecting one', async () => {
  const events = []
  const result = await handleSubtitles(args, options([first, second], e => events.push(e)))
  const event = events.find(e => e.event === 'subtitle-result')
  assert.equal(event.englishSelectedId, '')
  assert.deepEqual(event.englishSourceIds, ['en-1', 'en-2'])
  assert.equal(event.aiCandidateCount, 2)
  assert.deepEqual(result.subtitles.map(item => item.lang), ['msa', 'msa', 'eng', 'eng'])
  assert.deepEqual(result.subtitles.slice(0, 2).map(item => item.id), ['gemini-ai-en-1', 'gemini-ai-en-2'])
  assert.deepEqual(result.subtitles.slice(2).map(item => item.url), [first.url, second.url])
  assert.equal(result.autoPrefetch, false)
  assert.equal(result.autoPrefetchReason, 'on-demand-candidate-selection')
  assert.equal(event.englishSelectedScore, undefined)
  assert.equal(event.englishConfidence, undefined)
  assert.equal(event.nativeConfidence, undefined)
  assert.equal(event.autoReady, true)
})

test('native Malay and on-demand Malay AI are both offered regardless of metadata', async () => {
  for (const extra of [{}, { filename: 'native.srt', videoHash: 'native' }]) {
    const events = []
    const result = await handleSubtitles({ ...args, extra }, options([native, first], e => events.push(e)))
    assert.deepEqual(result.subtitles.map(item => item.lang), ['msa', 'msa', 'eng'])
    assert.equal(result.subtitles[0].id, 'ms-1')
    assert.match(result.subtitles[1].id, /^gemini-ai-/)
    assert.equal(result.autoPrefetch, false)
    assert.equal(events.find(e => e.event === 'subtitle-result').autoReady, true)
  }
})

test('invalid English URLs are skipped; lack of English or API key never fabricates Malay AI', async () => {
  const bad = { id: 'invalid', lang: 'eng' }
  const result = await handleSubtitles(args, options([bad, first, { ...first, id: 'duplicate' }]))
  assert.deepEqual(result.subtitles.map(item => item.id), [result.subtitles[0].id, 'opensubtitles-eng-en-1'])
  assert.equal(result.autoPrefetch, false)
  const noEnglish = await handleSubtitles(args, options([native]))
  assert.deepEqual(noEnglish.subtitles.map(item => item.id), ['ms-1'])
  assert.equal(noEnglish.autoPrefetch, false)
  const noKey = await handleSubtitles(args, { ...options([first]), apiKey: '' })
  assert.deepEqual(noKey.subtitles.map(item => item.lang), ['eng'])
  assert.equal(noKey.autoPrefetch, false)
})

test('sanitised diagnostics preserves upstream source list and does not add scores', () => {
  const event = sanitiseEvent({ event: 'subtitle-result', englishSelectedId: 'en-1',
    englishSourceIds: ['en-1', 'en-2'], englishCandidateCount: 2 })
  assert.deepEqual(event.englishSourceIds, ['en-1', 'en-2'])
  assert.equal(event.englishSelectedScore, undefined)
})

test('Compact Diagnose shows Malay AI and source order without speculative sync confidence', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('private', [{ event: 'subtitle-result', ts: Date.now(),
    id: args.id, type: args.type, autoReady: true, subtitleCount: 3,
    englishSelectedId: 'en-1', englishSourceIds: ['en-1', 'en-2'], englishCandidateCount: 2 }])
  assert.match(html, /<div class="label">Malay AI<\/div><div class="value">Ready<\/div>/)
  assert.match(html, /<summary>Source details<\/summary>/)
  assert.match(html, /#1<\/span><strong>en-1<\/strong>/)
  assert.doesNotMatch(html, /<h2>Sync confidence<\/h2>|selected score|Source &amp; sync details/)
})
