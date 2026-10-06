'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { deriveVerdict } = require('../src/diagnostics')

const when = (minute, second = 0) => Date.UTC(2026, 9, 6, 8, minute, second)
const subtitle = {
  ts: when(20), event: 'subtitle-result', type: 'series', id: 'tt9288030:2:2',
  result: 'on-demand-ai-ready', subtitleCount: 7, englishTrackCount: 3,
  aiCandidateCount: 3, malayCount: 1, autoReady: true
}

test('latest AI selection becomes verdict boundary within the same episode', () => {
  const events = [
    subtitle,
    { ts: when(21), event: 'translation-request', status: 'player', sourceId: '9822245' },
    { ts: when(21, 20), event: 'translation-delivered', sourceId: '9822245', cache: 'MISS', totalMs: 20000 },
    { ts: when(22), event: 'translation-request', status: 'player', sourceId: '9822246' }
  ]
  assert.equal(deriveVerdict(events), 'TRANSLATION_REQUESTED_WAITING_FOR_RESULT')
})

test('older source completion cannot override newer selected source hero and overview', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const events = [
    subtitle,
    { ts: when(21), event: 'translation-request', status: 'player', sourceId: '9822245' },
    { ts: when(21, 20), event: 'queue-translation-complete', sourceId: '9822245', totalMs: 31800, geminiTotalTokensTotal: 44984 },
    { ts: when(21, 21), event: 'translation-delivered', sourceId: '9822245', cache: 'MISS', totalMs: 1320 },
    { ts: when(22), event: 'translation-request', status: 'player', sourceId: '9822246' },
    // Source A finishes/reports again after B is selected. It must be ignored for current state.
    { ts: when(22, 2), event: 'translation-delivered', sourceId: '9822245', cache: 'HIT', totalMs: 420 }
  ]
  const html = renderConfiguredDiagnosePage('config', events)
  assert.match(html, /OpenSubtitles source 9822246\./)
  assert.match(html, /Latest AI selection: 06\/10\/2026, 4:22:00 pm MYT · Source 9822246/)
  assert.match(html, /<div class="label">English source<\/div><div class="value">9822246<\/div><div class="sub">OpenSubtitles<\/div>/)
  assert.match(html, /<div class="label">Translation<\/div><div class="value">Preparing<\/div><div class="sub">Selected source is being prepared<\/div>/)
  assert.match(html, /<div class="label">Delivery<\/div><div class="value">—<\/div><div class="sub">Not started<\/div>/)
  assert.doesNotMatch(html, /31\.8 s · 44,984 tokens/)
})

test('hero and lifecycle metrics move to second source after its delivery', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const events = [
    subtitle,
    { ts: when(21), event: 'translation-request', status: 'player', sourceId: '9822245' },
    { ts: when(21, 20), event: 'queue-translation-complete', sourceId: '9822245', totalMs: 31800, geminiTotalTokensTotal: 44984 },
    { ts: when(21, 21), event: 'translation-delivered', sourceId: '9822245', cache: 'MISS', totalMs: 1320 },
    { ts: when(22), event: 'translation-request', status: 'player', sourceId: '9822246' },
    { ts: when(22, 12), event: 'queue-translation-complete', sourceId: '9822246', totalMs: 12100, geminiTotalTokensTotal: 30210 },
    { ts: when(22, 13), event: 'translation-delivered', sourceId: '9822246', cache: 'MISS', totalMs: 760 }
  ]
  const html = renderConfiguredDiagnosePage('config', events)
  assert.match(html, /Malay subtitle delivered/)
  assert.match(html, /OpenSubtitles source 9822246\. The translated Malay VTT was successfully returned to the player\./)
  assert.match(html, /<div class="label">English source<\/div><div class="value">9822246<\/div>/)
  assert.match(html, /<div class="label">Translation<\/div><div class="value">Ready<\/div><div class="sub">12\.1 s · 30,210 tokens<\/div>/)
  assert.match(html, /<div class="label">Delivery<\/div><div class="value">MISS<\/div><div class="sub">760 ms · Delivered<\/div>/)
})
