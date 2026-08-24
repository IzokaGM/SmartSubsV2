'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { handleSubtitles, hasPlayerSyncMetadata } = require('../src/subtitles')
const { createUserConfigToken } = require('../src/user-config')

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('Part 5.2.2 recognises only supported player sync metadata', () => {
  assert.equal(hasPlayerSyncMetadata({}), false)
  assert.equal(hasPlayerSyncMetadata({ filename: '   ' }), false)
  assert.equal(hasPlayerSyncMetadata({ filename: 'Show.S01E01.mkv' }), true)
  assert.equal(hasPlayerSyncMetadata({ fileName: 'Show.S01E01.mkv' }), true)
  assert.equal(hasPlayerSyncMetadata({ videoHash: 'abc123' }), true)
  assert.equal(hasPlayerSyncMetadata({ videoSize: '734003200' }), true)
})

test('Part 5.2.2 skips SubSource completely when player sync metadata is absent', async () => {
  const diagnostics = []
  let fusionCalls = 0
  const result = await handleSubtitles({
    type: 'series',
    id: 'tt10986410:1:5',
    extra: {}
  }, {
    apiKey: 'gemini-key',
    tokenSecret: 'token-secret',
    publicBaseUrl: 'https://smartsubsv2.example/c/token',
    includeEnglishTracks: true,
    subsourceApiKey: 'subsource-key',
    fetchImpl: async () => jsonResponse({ subtitles: [
      { id: '11924288', lang: 'msa', url: 'https://os.example/native.srt' },
      { id: '83331674', lang: 'eng', url: 'https://os.example/english.srt' }
    ] }),
    fetchSubsourceCandidatesFn: async () => {
      fusionCalls += 1
      return { candidates: [] }
    },
    onDiagnostic: event => diagnostics.push(event)
  })

  assert.equal(fusionCalls, 0)
  assert.equal(result.subtitles.some(item => item.url === 'https://os.example/native.srt'), true)
  assert.equal(result.subtitles.some(item => item.lang === 'msa' && String(item.url).includes('/translated/')), true)
  const fusion = diagnostics.find(item => item.event === 'subsource-fusion')
  assert.equal(fusion.subsourceStatus, 'skipped-no-sync-metadata')
  assert.equal(fusion.subsourceEligible, false)
  assert.equal(fusion.subsourceTriggered, false)
  assert.equal(fusion.subsourceCandidateCount, 0)
  assert.equal(fusion.subsourceLatencyMs, 0)
})

for (const [label, extra] of [
  ['filename', { filename: 'Show.S01E05.1080p.WEB-DL.x265-GROUP.mkv' }],
  ['video hash', { videoHash: 'abc123' }],
  ['video size', { videoSize: '734003200' }]
]) {
  test(`Part 5.2.2 permits adaptive SubSource lookup with ${label}`, async () => {
    const diagnostics = []
    let fusionCalls = 0
    await handleSubtitles({ type: 'series', id: 'tt10986410:1:5', extra }, {
      apiKey: 'gemini-key',
      tokenSecret: 'token-secret',
      publicBaseUrl: 'https://smartsubsv2.example/c/token',
      subsourceApiKey: 'subsource-key',
      fetchImpl: async () => jsonResponse({ subtitles: [
        { id: 'os-eng', lang: 'eng', url: 'https://os.example/english.srt' }
      ] }),
      fetchSubsourceCandidatesFn: async () => {
        fusionCalls += 1
        return { candidates: [], latencyMs: 7, cache: 'MISS' }
      },
      onDiagnostic: event => diagnostics.push(event)
    })
    assert.equal(fusionCalls, 1)
    const fusion = diagnostics.find(item => item.event === 'subsource-fusion')
    assert.equal(fusion.subsourceEligible, true)
    assert.equal(fusion.subsourceTriggered, true)
  })
}

test('Part 5.2.2 Diagnose explains the eligibility gate', async () => {
  const { handleRequest } = await import('../src/cloudflare-worker.mjs')
  const secret = 'part522-secret'
  const token = createUserConfigToken('gemini-key-12345678901234567890', {
    secret,
    subsourceApiKey: 'subsource-key-1234567890',
    iv: Buffer.alloc(12, 7)
  })
  const response = await handleRequest(new Request(
    `https://smartsubsv2.example/c/${encodeURIComponent(token)}/diagnose`
  ), { SMARTSUBS_SECRET: secret })
  const html = await response.text()
  assert.match(html, /SubSource is skipped when the player supplies no filename, video hash or video size/)
  const health = await handleRequest(new Request('https://smartsubsv2.example/health'), {})
  assert.equal((await health.json()).build, 'part5-2-2-subsource-eligibility-gate')
})
