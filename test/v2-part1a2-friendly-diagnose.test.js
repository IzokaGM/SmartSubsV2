'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

test('V2 friendly diagnose shows Malaysia time and sync-risk summary', async () => {
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
  assert.match(html, /Malaysia time \(MYT, Asia\/Kuala_Lumpur\)/)
  assert.match(html, /21\/08\/2026/)
  assert.match(html, /12:42:47/)
  assert.match(html, /Selected English source/)
  assert.match(html, /9214195/)
  assert.match(html, /HIGH RISK/)
  assert.match(html, /only 1 point/)
  assert.match(html, /Latest delivery cache/)
  assert.match(html, />HIT</)
  assert.match(html, /411 ms/)
  assert.match(html, /Verdict reference/)
  assert.match(html, /SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION/)
  assert.match(html, /Raw recent events/)
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

  assert.match(html, /STRONG/)
  assert.match(html, /video hash/)
})
