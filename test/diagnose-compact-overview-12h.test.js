'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const load = async () => (await import('../src/cloudflare-worker.mjs')).renderConfiguredDiagnosePage
const when = (hour, minute = 0, second = 0) => Date.UTC(2026, 8, 24, hour, minute, second)
const subtitle = (ts, id = 'tt1196946:2:23') => ({
  ts, event: 'subtitle-result', type: 'series', id, result: 'on-demand-ai-ready',
  subtitleCount: 6, englishTrackCount: 3, aiCandidateCount: 3, englishSelectedId: ''
})

test('Optimized Overview keeps media plus 2x2 lifecycle metrics with readable values', async () => {
  const render = await load()
  const html = render('config', [
    subtitle(when(13, 26, 40)),
    { ts: when(13, 26, 55), event: 'queue-translation-complete', sourceId: '9280753', totalMs: 29887, geminiTotalTokensTotal: 79513 },
    { ts: when(13, 27, 10), event: 'translation-delivered', sourceId: '9280753', cache: 'HIT', totalMs: 375 }
  ])
  assert.match(html, /class="diagnose-heading"><h1>SmartSubsV2 Diagnose<\/h1><div class="muted">\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [ap]m MYT<\/div>/)
  assert.match(html, /Latest subtitle request: 24\/09\/2026, 9:26:40 pm MYT/)
  assert.doesNotMatch(html, /MYT\s*\|\s*MYT/)
  assert.match(html, /class="metric media-metric"[^>]*><div class="label">Latest media<\/div><div class="value">S2E23 · tt1196946:2:23<\/div>/)
  assert.match(html, /<div class="label">Available<\/div><div class="value">6 tracks<\/div><div class="sub">3 AI · 3 English<\/div>/)
  assert.match(html, /<div class="label">English source<\/div><div class="value">9280753<\/div><div class="sub">OpenSubtitles<\/div>/)
  assert.match(html, /<div class="label">Translation<\/div><div class="value">Ready<\/div><div class="sub">29\.9 s · 79,513 tokens<\/div>/)
  assert.match(html, /<div class="label">Delivery<\/div><div class="value">HIT<\/div><div class="sub">375 ms · Delivered<\/div>/)
  assert.match(html, /<time>24\/09\/2026, 9:27:10 pm MYT<\/time>/)
  assert.match(html, /\.media-metric\{grid-column:1\/-1\}/)
  assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
})

test('Never display older media delivery and translation as latest request results', async () => {
  const render = await load()
  const html = render('config', [
    {ts:when(10), event:'queue-translation-complete', sourceId:'old', totalMs:29887},
    {ts:when(10,1), event:'translation-delivered', sourceId:'old', totalMs:375, cache:'HIT'},
    subtitle(when(11), 'tt1196946:2:24')
  ])
  assert.match(html, /S2E24 · tt1196946:2:24/)
  assert.match(html, /<div class="label">English source<\/div><div class="value">—<\/div><div class="sub">Not selected<\/div>/)
  assert.match(html, /<div class="label">Translation<\/div><div class="value">Waiting<\/div><div class="sub">Select an AI track<\/div>/)
  assert.match(html, /<div class="label">Delivery<\/div><div class="value">—<\/div><div class="sub">Not started<\/div>/)
  assert.match(html, /<h2>Technical Events <span class="event-count">3<\/span><\/h2>/)
  assert.doesNotMatch(html, /<details><summary>Technical events/)
})

test('OFF view keeps centered heading, MYT 12-hour clock and protected ON controls', async () => {
  const render = await load()
  const html = render('config', [], {enabled:false, ready:true})
  assert.match(html, /<header class="diagnose-heading"><h1>SmartSubsV2 Diagnose<\/h1><div class="muted">\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [ap]m MYT<\/div>/)
  assert.match(html, /Diagnostics:<\/span><a class="diag-status-toggle neutral" href="#diag-admin">OFF<\/a>/)
  assert.match(html, /minlength="6"/)
  assert.match(html, /value="on"/)
})
