'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function decodeHtml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

test('Diagnose exports already-loaded events as client-side JSON/TXT without another KV request', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('config', [
    {
      ts: Date.UTC(2026, 9, 6, 5, 30, 0),
      event: 'subtitle-result',
      type: 'series',
      id: 'tt1196946:1:2',
      result: 'on-demand-ai-ready',
      subtitleCount: 14,
      englishTrackCount: 7,
      aiCandidateCount: 7,
      sourceFilename: 'Movie & </textarea>.srt',
      apiKey: 'must-never-export',
      url: 'https://secret.example/private.srt'
    },
    {
      ts: Date.UTC(2026, 9, 6, 5, 31, 0),
      event: 'translation-delivered',
      sourceId: '4374548',
      cache: 'HIT',
      totalMs: 677
    }
  ])

  assert.match(html, /id="save-log-json"[^>]*>Save Log \(\.json\)<\/button>/)
  assert.match(html, /id="save-log-txt"[^>]*>Save Summary \(\.txt\)<\/button>/)
  assert.match(html, /No additional KV read or write\./)

  const dataMatch = html.match(/<textarea id="diagnose-export-data" hidden>([\s\S]*?)<\/textarea>/)
  assert.ok(dataMatch, 'embedded export payload must exist')
  const payload = JSON.parse(decodeHtml(dataMatch[1]))
  assert.equal(payload.format, 'smartsubsv2-diagnose-log-v1')
  assert.equal(payload.build, 'v2-multicandidate-ondemand-6')
  assert.equal(payload.overview.latestMedia, 'S1E2 · tt1196946:1:2')
  assert.equal(payload.overview.englishSource, '4374548')
  assert.equal(payload.events.length, 2)
  assert.equal(payload.events[0].sourceId, '4374548')
  assert.equal(payload.events[1].sourceFilename, 'Movie & </textarea>.srt')
  assert.doesNotMatch(dataMatch[1], /must-never-export|secret\.example|apiKey|"url"/)

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(scriptMatch, 'client-side download script must exist')
  assert.doesNotThrow(() => new Function(scriptMatch[1]))
  assert.match(scriptMatch[1], /new Blob\(/)
  assert.match(scriptMatch[1], /URL\.createObjectURL\(/)
  assert.doesNotMatch(scriptMatch[1], /\bfetch\s*\(|XMLHttpRequest|sendBeacon/)
})
