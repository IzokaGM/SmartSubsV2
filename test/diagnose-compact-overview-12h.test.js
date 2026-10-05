'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const load = async () => (await import('../src/cloudflare-worker.mjs')).renderConfiguredDiagnosePage
const when = (hour, minute = 0, second = 0) => Date.UTC(2026, 8, 24, hour, minute, second)
const subtitle = (ts, id = 'tt1196946:2:23') => ({
  ts, event: 'subtitle-result', type: 'series', id, result: 'auto-malay-ready',
  subtitleCount: 6, englishSelectedId: '9280753'
})

test('Compact Overview keeps 1 full-width media and 2x2 fixed metrics with readable values', async () => {
  const render = await load()
  const html = render('config', [
    subtitle(when(13, 26, 40)),
    { ts: when(13, 26, 55), event: 'queue-translation-complete', totalMs: 29887 },
    { ts: when(13, 27, 10), event: 'translation-delivered', cache: 'HIT', totalMs: 375 }
  ])
  assert.match(html, /class="diagnose-heading"><h1>SmartSubsV2 Diagnose<\/h1><div class="muted">\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [ap]m MYT<\/div>/)
  assert.match(html, /Latest subtitle request: 24\/09\/2026, 9:26:40 pm MYT/)
  assert.doesNotMatch(html, /MYT\s*\|\s*MYT/)
  assert.match(html, /class="metric media-metric"[^>]*><div class="label">Latest media<\/div><div class="value">S2E23 · tt1196946:2:23<\/div>/)
  assert.match(html, /<div class="label">Malay AI<\/div><div class="value">Ready<\/div>/)
  assert.match(html, /<div class="label">English source<\/div><div class="value">9280753<\/div>/)
  assert.match(html, /<div class="label">Delivery<\/div><div class="value">375 ms<\/div><div class="sub">HIT<\/div>/)
  assert.match(html, /<div class="label">Cold translation<\/div><div class="value">29\.9 s<\/div>/)
  assert.match(html, /<time>24\/09\/2026, 9:27:10 pm MYT<\/time>/)
  assert.match(html, /\.media-metric\{grid-column:1\/-1\}/)
  assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
})

test('Never display older media delivery and cold translation as latest request results', async () => {
  const render = await load()
  const html = render('config', [
    {ts:when(10), event:'queue-translation-complete', totalMs:29887},
    {ts:when(10,1), event:'translation-delivered', totalMs:375, cache:'HIT'},
    subtitle(when(11), 'tt1196946:2:24')
  ])
  assert.match(html, /S2E24 · tt1196946:2:24/)
  assert.match(html, /<div class="label">Delivery<\/div><div class="value">—<\/div><div class="sub">Not recorded<\/div>/)
  assert.match(html, /<div class="label">Cold translation<\/div><div class="value">—<\/div><div class="sub">Not recorded for this request<\/div>/)
  assert.match(html, /<summary>Technical events \(3\)<\/summary>/)
})

test('OFF view keeps centered heading, MYT 12-hour clock and protected ON controls', async () => {
  const render = await load()
  const html = render('config', [], {enabled:false, ready:true})
  assert.match(html, /<header class="diagnose-heading"><h1>SmartSubsV2 Diagnose<\/h1><div class="muted">\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [ap]m MYT<\/div>/)
  assert.match(html, /minlength="6"/)
  assert.match(html, /value="on"/)
})
