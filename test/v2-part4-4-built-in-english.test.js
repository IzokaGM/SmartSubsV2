
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildEnglishTracks, handleSubtitles } = require('../src/subtitles')

function responseFor(subtitles) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ subtitles })
  })
}

test('Part 4.4 exposes up to five ranked and deduplicated English tracks', () => {
  const upstream = [
    { id: 'wrong', lang: 'eng', url: 'https://example.test/Show.720p.HDTV-WRONG.srt' },
    { id: 'best', lang: 'eng', url: 'https://example.test/Show.1080p.WEB-DL.x265-GROUP.srt' },
    { id: 'best-copy', lang: 'eng', url: 'https://example.test/Show.1080p.WEB-DL.x265-GROUP.srt' },
    { id: 'third', lang: 'en', url: 'https://example.test/third.srt' },
    { id: 'fourth', lang: 'english', url: 'https://example.test/fourth.srt' },
    { id: 'fifth', lang: 'eng', url: 'https://example.test/fifth.srt' },
    { id: 'sixth', lang: 'eng', url: 'https://example.test/sixth.srt' }
  ]

  const tracks = buildEnglishTracks(upstream, {
    filename: 'Show.1080p.WEB-DL.x265-GROUP.mkv'
  })

  assert.equal(tracks.length, 5)
  assert.equal(tracks[0].id, 'smartsubs-eng-best')
  assert.deepEqual(new Set(tracks.map(item => item.url)).size, 5)
  assert.deepEqual(new Set(tracks.map(item => item.lang)), new Set(['eng']))
})

test('Part 4.4 returns Malay Auto first and ranked English alternatives after it', async () => {
  const result = await handleSubtitles({
    type: 'series',
    id: 'tt10986410:1:5',
    extra: {}
  }, {
    apiKey: 'test-key',
    publicBaseUrl: 'https://smartsubsv2.example/c/test',
    tokenSecret: 'test-secret',
    includeEnglishTracks: true,
    fetchImpl: responseFor([
      { id: 'eng-one', lang: 'eng', url: 'https://example.test/one.srt' },
      { id: 'eng-two', lang: 'eng', url: 'https://example.test/two.srt' }
    ])
  })

  assert.equal(result.subtitles.length, 3)
  assert.equal(result.subtitles[0].lang, 'msa')
  assert.match(result.subtitles[0].id, /^smartsubs-auto-/)
  assert.deepEqual(result.subtitles.slice(1).map(item => item.lang), ['eng', 'eng'])
  assert.deepEqual(result.subtitles.slice(1).map(item => item.id), [
    'smartsubs-eng-eng-one',
    'smartsubs-eng-eng-two'
  ])
  assert.equal(result.autoPrefetch, true)
})

test('Part 4.4 keeps weak-native quota protection and adds English after Malay choices', async () => {
  const result = await handleSubtitles({
    type: 'series',
    id: 'tt10986410:1:5',
    extra: { filename: 'Ted Lasso Season 1 (2020) S01E05-onetouchtv' }
  }, {
    apiKey: 'test-key',
    publicBaseUrl: 'https://smartsubsv2.example/c/test',
    tokenSecret: 'test-secret',
    includeEnglishTracks: true,
    fetchImpl: responseFor([
      { id: 'native-weak', lang: 'may', url: 'https://example.test/native.srt' },
      { id: 'english-weak', lang: 'eng', url: 'https://example.test/english.srt' }
    ])
  })

  assert.deepEqual(result.subtitles.map(item => item.lang), ['msa', 'msa', 'eng'])
  assert.equal(result.subtitles[2].id, 'smartsubs-eng-english-weak')
  assert.equal(result.autoPrefetch, false)
  assert.equal(result.autoPrefetchReason, 'weak-native-wait-for-user-selection')
})

test('Part 4.4 can still return English when Malay Auto is unavailable', async () => {
  const events = []
  const result = await handleSubtitles({
    type: 'movie',
    id: 'tt1375666',
    extra: {}
  }, {
    includeEnglishTracks: true,
    fetchImpl: responseFor([
      { id: 'english-direct', lang: 'eng', url: 'https://example.test/direct.srt' }
    ]),
    onDiagnostic: async event => events.push(event)
  })

  assert.deepEqual(result.subtitles, [{
    id: 'smartsubs-eng-english-direct',
    lang: 'eng',
    url: 'https://example.test/direct.srt'
  }])
  const event = events.find(item => item.event === 'subtitle-result')
  assert.equal(event.englishTrackCount, 1)
  assert.equal(event.subtitleCount, 1)
  assert.deepEqual(event.languages, ['eng'])
})
