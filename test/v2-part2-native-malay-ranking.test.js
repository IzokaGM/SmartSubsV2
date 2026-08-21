'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  rankMalaySubtitles,
  selectBestMalay,
  selectBestEnglish
} = require('../src/selector')
const { handleSubtitles } = require('../src/subtitles')
const { sanitiseEvent } = require('../src/diagnostics')

function responseFor(subtitles) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ subtitles })
  })
}

test('Part 2 ranks a matching native Malay release above an earlier mismatched release', () => {
  const candidates = [
    {
      id: 'malay-wrong',
      lang: 'ms',
      url: 'https://example.test/Show.S01E01.1080p.BluRay.x264-OTHER.srt'
    },
    {
      id: 'malay-match',
      lang: 'msa',
      url: 'https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.srt'
    }
  ]

  const context = {
    filename: 'Show.S01E01.1080p.WEB-DL.x265-GROUP.mkv'
  }

  const ranked = rankMalaySubtitles(candidates, context)

  assert.equal(ranked[0].subtitle.id, 'malay-match')
  assert.ok(ranked[0].score > ranked[1].score)
  assert.equal(selectBestMalay(candidates, context).id, 'malay-match')
})

test('Part 2 exact video hash wins native Malay ranking', () => {
  const candidates = [
    {
      id: 'filename-match',
      lang: 'ms',
      url: 'https://example.test/Movie.2026.1080p.WEB-DL.x265-GROUP.srt'
    },
    {
      id: 'hash-match',
      lang: 'ms',
      url: 'https://example.test/Movie.2026.1080p.BluRay.x264-OTHER.srt',
      videoHash: 'abc123'
    }
  ]

  const ranked = rankMalaySubtitles(candidates, {
    filename: 'Movie.2026.1080p.WEB-DL.x265-GROUP.mkv',
    videoHash: 'abc123'
  })

  assert.equal(ranked[0].subtitle.id, 'hash-match')
})

test('Part 2 keeps upstream Malay order when no useful metadata distinguishes candidates', () => {
  const candidates = [
    { id: 'first', lang: 'ms', url: 'https://example.test/a.srt' },
    { id: 'second', lang: 'msa', url: 'https://example.test/b.srt' }
  ]

  const ranked = rankMalaySubtitles(candidates, {})

  assert.deepEqual(ranked.map(item => item.subtitle.id), ['first', 'second'])
})

test('Part 2 returns the strongest native Malay candidate first and records diagnose evidence', async () => {
  const upstream = [
    {
      id: 'malay-wrong',
      lang: 'ms',
      url: 'https://example.test/Show.S01E01.1080p.BluRay.x264-OTHER.srt'
    },
    {
      id: 'malay-match',
      lang: 'msa',
      url: 'https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.srt'
    },
    {
      id: 'english-match',
      lang: 'eng',
      url: 'https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.en.srt'
    }
  ]

  const events = []
  const result = await handleSubtitles({
    type: 'series',
    id: 'tt11198330:1:1',
    extra: {
      filename: 'Show.S01E01.1080p.WEB-DL.x265-GROUP.mkv'
    }
  }, {
    fetchImpl: responseFor(upstream),
    onDiagnostic: async event => events.push(event)
  })

  assert.equal(result.subtitles.length, 2)
  assert.equal(result.subtitles[0].id, 'malay-match')
  assert.equal(result.subtitles[1].id, 'malay-wrong')
  assert.deepEqual(result.subtitles.map(item => item.lang), ['msa', 'msa'])

  const event = events.find(item => item.event === 'subtitle-result')
  assert.ok(event)
  assert.equal(event.result, 'native-malay')
  assert.equal(event.malayCandidateCount, 2)
  assert.equal(event.malaySelectedId, 'malay-match')
  assert.equal(typeof event.malaySelectedScore, 'number')
  assert.match(event.malayTop[0], /^1:malay-match:/)
})

test('Part 2 does not change English Auto selection when native Malay is absent', async () => {
  const upstream = [
    {
      id: 'english-wrong',
      lang: 'eng',
      url: 'https://example.test/Show.S01E01.1080p.BluRay.x264-OTHER.srt'
    },
    {
      id: 'english-match',
      lang: 'eng',
      url: 'https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.srt'
    }
  ]

  const extra = {
    filename: 'Show.S01E01.1080p.WEB-DL.x265-GROUP.mkv'
  }
  const expectedEnglish = selectBestEnglish(upstream, extra)
  const events = []

  const result = await handleSubtitles({
    type: 'series',
    id: 'tt11198330:1:1',
    extra
  }, {
    apiKey: 'test-key',
    publicBaseUrl: 'https://smartsubsv2.example/c/test',
    tokenSecret: 'test-secret',
    fetchImpl: responseFor(upstream),
    onDiagnostic: async event => events.push(event)
  })

  assert.equal(result.subtitles.length, 1)

  const event = events.find(item => item.event === 'subtitle-result')
  assert.ok(event)
  assert.equal(event.result, 'auto-malay-ready')
  assert.equal(event.malayCandidateCount, 0)
  assert.equal(event.malaySelectedId, '')
  assert.equal(event.englishSelectedId, expectedEnglish.id)
  assert.equal(event.englishSelectedId, 'english-match')
})

test('Part 2 diagnostic sanitizer preserves native Malay ranking evidence', () => {
  const clean = sanitiseEvent({
    event: 'subtitle-result',
    malayCount: 3,
    malayCandidateCount: 3,
    malaySelectedId: 'malay-best',
    malaySelectedScore: 12345,
    malayTop: [
      '1:malay-best:12345',
      '2:malay-next:11000',
      '3:malay-third:10000'
    ]
  })

  assert.equal(clean.malayCount, 3)
  assert.equal(clean.malayCandidateCount, 3)
  assert.equal(clean.malaySelectedId, 'malay-best')
  assert.equal(clean.malaySelectedScore, 12345)
  assert.deepEqual(clean.malayTop, [
    '1:malay-best:12345',
    '2:malay-next:11000',
    '3:malay-third:10000'
  ])
})
