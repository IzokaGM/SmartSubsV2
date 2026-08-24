'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { zipSync, strToU8 } = require('fflate')
const { selectMovie } = require('../src/subsource')
const { handleSubtitles, admitSubsourceCandidates, seriesReleaseMatches } = require('../src/subtitles')
const { extractSubtitleArchive } = require('../src/subsource-archive')
const { createUserConfigToken } = require('../src/user-config')

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('Part 5.2.1 never falls back to a different SubSource season for the same IMDb id', () => {
  const media = { imdbId: 'tt10986410', season: 1, episode: 1 }
  assert.equal(selectMovie([
    { movieId: 900, imdbId: 'tt10986410', season: 2, type: 'series' }
  ], media, 'series'), null)
  assert.equal(selectMovie([
    { movieId: 901, imdbId: 'tt10986410', season: 1, type: 'series' }
  ], media, 'series').movieId, 901)
})

test('Part 5.2.1 requires exact series season and episode evidence from SubSource release info', () => {
  const exact = { provider: 'subsource', lang: 'msa', releaseInfo: ['Ted.Lasso.S01E01.1080p.WEB-DL.x265-GROUP'] }
  const wrongSeason = { provider: 'subsource', lang: 'msa', releaseInfo: ['Ted.Lasso.S02E01.1080p.WEB-DL.x265-GROUP'] }
  const unknownEpisode = { provider: 'subsource', lang: 'msa', releaseInfo: ['Ted.Lasso.1080p.WEB-DL.x265-GROUP'] }
  assert.equal(seriesReleaseMatches(exact, 'tt10986410:1:1'), true)
  assert.equal(seriesReleaseMatches(wrongSeason, 'tt10986410:1:1'), false)
  assert.equal(seriesReleaseMatches(unknownEpisode, 'tt10986410:1:1'), false)
})

test('Part 5.2.1 rejects weak and wrong-episode SubSource candidates before Stremio sees them', async () => {
  const diagnostics = []
  const result = await handleSubtitles({
    type: 'series',
    id: 'tt10986410:1:1',
    extra: { filename: 'Ted Lasso Season 1 (2020) S01E01-onetouchtv' }
  }, {
    apiKey: 'gemini-key',
    tokenSecret: 'token-secret',
    publicBaseUrl: 'https://smartsubsv2.example/c/token',
    includeEnglishTracks: true,
    subsourceApiKey: 'subsource-key',
    fetchImpl: async () => jsonResponse({ subtitles: [
      { id: '11924283', lang: 'msa', url: 'https://os.example/native.srt' },
      { id: '8333623', lang: 'eng', url: 'https://os.example/english.srt' }
    ] }),
    fetchSubsourceCandidatesFn: async () => ({
      cache: 'HIT', latencyMs: 16,
      candidates: [
        { id: 'subsource-2550703', provider: 'subsource', lang: 'msa', url: 'https://worker/subsource/2550703/2/1.srt', releaseInfo: ['Other.Show.S02E01.720p.HDTV'] },
        { id: 'subsource-2271741', provider: 'subsource', lang: 'eng', url: 'https://worker/subsource/2271741/1/1.srt', releaseInfo: ['Ted.Lasso.S01E01.720p.BluRay'] }
      ]
    }),
    onDiagnostic: event => diagnostics.push(event)
  })
  assert.equal(result.subtitles.some(item => String(item.url).includes('/subsource/')), false)
  assert.equal(result.subtitles.some(item => item.url === 'https://os.example/native.srt'), true)
  assert.equal(result.subtitles.some(item => item.lang === 'msa' && String(item.url).includes('/translated/')), true)
  const fusion = diagnostics.find(item => item.event === 'subsource-fusion')
  assert.equal(fusion.subsourceAcceptedCount, 0)
  assert.equal(fusion.subsourceRejectedCount, 2)
})

test('Part 5.2.1 admits only a strong exact-episode SubSource candidate', () => {
  const candidates = [
    { id: 'safe', provider: 'subsource', lang: 'msa', url: 'https://worker/safe', releaseInfo: ['Show.S01E05.1080p.WEB-DL.x265-GROUP'] },
    { id: 'wrong', provider: 'subsource', lang: 'msa', url: 'https://worker/wrong', releaseInfo: ['Show.S02E05.1080p.WEB-DL.x265-GROUP'] }
  ]
  const admission = admitSubsourceCandidates(candidates, {
    type: 'series', id: 'tt1234567:1:5', extra: { filename: 'Show.S01E05.1080p.WEB-DL.x265-GROUP.mkv' }
  })
  assert.deepEqual(admission.accepted.map(item => item.id), ['safe'])
  assert.deepEqual(admission.rejected.map(item => item.subtitle.id), ['wrong'])
})

test('Part 5.2.1 ZIP extraction selects exact season and refuses a different season', () => {
  const both = zipSync({
    'Show.S02E01.srt': strToU8('1\n00:00:01,000 --> 00:00:02,000\nWrong season\n'),
    'Show.S01E01.srt': strToU8('1\n00:00:01,000 --> 00:00:02,000\nCorrect season\n')
  })
  assert.match(extractSubtitleArchive(both, 1, 1).text, /Correct season/)
  const wrongOnly = zipSync({
    'Show.S02E01.srt': strToU8('1\n00:00:01,000 --> 00:00:02,000\nWrong season\n')
  })
  assert.throws(() => extractSubtitleArchive(wrongOnly, 1, 1), /no supported subtitle file/)
})

test('Part 5.2.1 retires unsafe episode-only SubSource URLs', async () => {
  const { handleRequest } = await import('../src/cloudflare-worker.mjs')
  const secret = 'part521-secret'
  const token = createUserConfigToken('gemini-key', {
    secret,
    subsourceApiKey: 'subsource-key',
    iv: Buffer.alloc(12, 8)
  })
  const response = await handleRequest(new Request(
    `https://smartsubsv2.example/c/${encodeURIComponent(token)}/subsource/2550703/1.srt`
  ), { SMARTSUBS_SECRET: secret })
  assert.equal(response.status, 410)
  assert.match(await response.text(), /Refresh the subtitle list/)
})
