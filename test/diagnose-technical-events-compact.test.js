'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitiseEvent } = require('../src/diagnostics')

const when = (hour, minute = 0, second = 0) => Date.UTC(2026, 9, 6, hour, minute, second)

test('Technical events render compact summaries with expandable raw details', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('config', [
    {
      ts: when(4, 50, 50), event: 'subtitle-result', type: 'series', id: 'tt1196946:1:2',
      result: 'on-demand-ai-ready', subtitleCount: 14, upstreamCount: 91,
      malayCount: 0, englishTrackCount: 7, aiCandidateCount: 7, autoPrefetch: false,
      englishSelectedId: '', englishSourceIds: ['4374548', '3340583']
    },
    {
      ts: when(4, 51, 20), event: 'queue-translation-complete', sourceId: '4374548',
      cache: 'MISS', totalMs: 26419, geminiCalls: 11, geminiTotalTokensTotal: 79513,
      chunks: 10, missing: 2, retryRecovered: 2
    },
    {
      ts: when(4, 51, 21), event: 'translation-delivered', sourceId: '4374548',
      cache: 'HIT', totalMs: 677, waitMs: 0, polls: 0, joinStatus: 'cache-hit'
    }
  ])

  assert.match(html, /<span class="event-badge good">DELIVERY<\/span>/)
  assert.match(html, /<div class="event-title">Translation delivered<\/div>/)
  assert.match(html, /Source 4374548 · Cache HIT · 677 ms/)
  assert.match(html, /<div class="event-title">Subtitle discovery<\/div>/)
  assert.match(html, /14 tracks · 7 AI Malay · 7 English/)
  assert.match(html, /<details class="event-raw"><summary>Raw details<\/summary>/)
  assert.match(html, /<b>englishSourceIds<\/b>=4374548,3340583/)
  assert.match(html, /<div class="label">English source<\/div><div class="value">4374548<\/div>/)
})

test('Diagnostic sanitizer keeps selected source ID in the existing event record', () => {
  const clean = sanitiseEvent({
    event: 'translation-delivered', sourceId: '4374548', cache: 'HIT', totalMs: 677
  })
  assert.equal(clean.sourceId, '4374548')
  assert.equal(clean.cache, 'HIT')
  assert.equal(clean.totalMs, 677)
})
