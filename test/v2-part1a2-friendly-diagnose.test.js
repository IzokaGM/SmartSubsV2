'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

test('Compact diagnose keeps relevant status without a source-details disclosure', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')

  const ts = Date.UTC(2026, 7, 21, 4, 42, 47)
  const html = renderConfiguredDiagnosePage('private-config', [
    {
      ts,
      event: 'subtitle-result',
      type: 'series',
      id: 'tt11198330:1:1',
      result: 'auto-malay-ready',
      subtitleCount: 1,
      languages: 'msa',
      sourceFilenameProvided: true,
      sourceVideoHashProvided: false,
      sourceVideoSizeProvided: false,
      sourceFilename: 'House of the Dragon - Season 1 S01E01-kisskh',
      englishCandidateCount: 6,
      englishSelectedId: '9214195',
      englishSelectedScore: 10020,
      englishTop: [
        '1:9214195:10020',
        '2:9215159:10019',
        '3:9215154:10018'
      ],
      autoReady: true
    },
    {
      ts: ts + 1000,
      event: 'translation-delivered',
      cache: 'HIT',
      totalMs: 411,
      waitMs: 0,
      polls: 0,
      joinStatus: 'cache-hit'
    }
  ])

  assert.match(html, /SmartSubsV2 Diagnose/)
  assert.match(html, /MYT/)
  assert.match(html, /21\/08\/2026/)
  assert.match(html, /12:42:47/)
  assert.match(html, /English source/)
  assert.match(html, /9214195/)
  assert.doesNotMatch(html, /Source details|Source timing is not verified/)
  assert.match(html, /<div class=\"label\">Delivery<\/div>/)
  assert.match(html, /<div class="sub">HIT<\/div>/)
  assert.match(html, /411 ms/)
  assert.doesNotMatch(html, /Verdict reference/)
  assert.doesNotMatch(html, /Player sync metadata<\/h2>/)
  assert.doesNotMatch(html, /Native Malay<\/div>/)
  assert.match(html, /<summary>Technical events \(2\)<\/summary>/)
  assert.match(html, /translation-delivered/)
})

test('V2 friendly diagnose rates video hash as strong sync evidence', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')

  const html = renderConfiguredDiagnosePage('private-config', [{
    ts: Date.UTC(2026, 7, 21, 4, 42, 47),
    event: 'subtitle-result',
    type: 'movie',
    id: 'tt123',
    result: 'auto-malay-ready',
    subtitleCount: 1,
    sourceFilenameProvided: true,
    sourceVideoHashProvided: true,
    sourceVideoSizeProvided: true,
    englishCandidateCount: 4,
    englishSelectedId: 'hash-match',
    englishSelectedScore: 40000,
    englishTop: ['1:hash-match:40000', '2:other:10000']
  }])

  assert.doesNotMatch(html, /Source details|Source timing is not verified/)
  assert.doesNotMatch(html, /<h2>Note<\/h2>/)
})

test('Compact diagnose keeps native Malay detail only when native subtitles exist', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('private-config', [{
    ts: Date.UTC(2026, 8, 24, 11), event: 'subtitle-result', type: 'series',
    id: 'tt123:1:2', result: 'native-malay', malayCount: 1,
    nativeDecision: 'native-malay-selected'
  }])
  assert.match(html, /<div class="label">Native Malay<\/div>/)
  assert.match(html, /<div class="value">Available<\/div>/)
})

test('Compact diagnose does not surface a stale failure after successful delivery', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('private-config', [
    { ts: 1000, event: 'translation-failed', failureStage: 'old-error' },
    { ts: 2000, event: 'translation-delivered', cache: 'HIT', totalMs: 234 }
  ])
  assert.doesNotMatch(html, /<h2>Latest failure<\/h2>/)
  assert.match(html, /<summary>Technical events \(2\)<\/summary>/)
  assert.match(html, /old-error/)
})
