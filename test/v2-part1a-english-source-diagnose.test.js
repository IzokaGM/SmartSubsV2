'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  handleSubtitles,
  englishSelectionDiagnostics
} = require('../src/subtitles')
const { selectBestEnglish } = require('../src/selector')
const { sanitiseEvent } = require('../src/diagnostics')

const responseFor = subtitles => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ subtitles })
})

test('Part 1A reports the selected English ID and top candidates without changing selection', async () => {
  const upstream = [
    {
      id: 'wrong-release',
      lang: 'eng',
      url: 'https://example.test/Show.S01E01.1080p.BluRay.x264-OTHER.srt'
    },
    {
      id: 'matching-release',
      lang: 'eng',
      url: 'https://example.test/Show.S01E01.1080p.WEB-DL.x265-GROUP.srt'
    }
  ]

  const extra = {
    filename: 'Show.S01E01.1080p.WEB-DL.x265-GROUP.mkv'
  }

  const expected = selectBestEnglish(upstream, extra)
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

  const event = events.find(item => item.event === 'subtitle-result')
  assert.ok(event)
  assert.equal(result.subtitles.length, 1)
  assert.equal(event.englishSelectedId, expected.id)
  assert.equal(event.englishSelectedId, 'matching-release')
  assert.equal(event.englishSelectionStable, true)
  assert.equal(event.englishCandidateCount, 2)
  assert.equal(event.sourceFilenameProvided, true)
  assert.equal(event.sourceVideoHashProvided, false)
  assert.equal(event.sourceVideoSizeProvided, false)
  assert.equal(event.sourceFilename, extra.filename)
  assert.deepEqual(event.requestExtraKeys, ['filename'])
  assert.match(event.englishTop[0], /^1:matching-release:/)
})

test('Part 1A makes weak no-metadata selection visible', () => {
  const upstream = [
    { id: 'first', lang: 'eng', url: 'https://example.test/first.srt' },
    { id: 'second', lang: 'eng', url: 'https://example.test/second.srt' }
  ]

  const selected = selectBestEnglish(upstream, {})
  const info = englishSelectionDiagnostics(upstream, selected, {})

  assert.equal(info.sourceFilenameProvided, false)
  assert.equal(info.sourceVideoHashProvided, false)
  assert.equal(info.sourceVideoSizeProvided, false)
  assert.equal(info.englishSelectedId, 'first')
  assert.equal(info.englishCandidateCount, 2)
  assert.equal(info.englishSelectionStable, true)
  assert.match(info.englishTop[0], /^1:first:/)
})

test('Part 1A diagnostic sanitizer keeps source-selection fields', () => {
  const clean = sanitiseEvent({
    event: 'subtitle-result',
    sourceFilenameProvided: true,
    sourceVideoHashProvided: false,
    sourceVideoSizeProvided: true,
    sourceFilename: 'Episode.S01E01.1080p.WEB-DL.mkv',
    requestExtraKeys: ['filename', 'videoSize'],
    englishCandidateCount: 8,
    englishSelectedId: '9215159',
    englishSelectedScore: 11120,
    englishSelectionStable: true,
    englishTop: ['1:9215159:11120', '2:9215154:10200']
  })

  assert.equal(clean.sourceFilenameProvided, true)
  assert.equal(clean.sourceVideoHashProvided, false)
  assert.equal(clean.sourceVideoSizeProvided, true)
  assert.equal(clean.sourceFilename, 'Episode.S01E01.1080p.WEB-DL.mkv')
  assert.deepEqual(clean.requestExtraKeys, ['filename', 'videoSize'])
  assert.equal(clean.englishCandidateCount, 8)
  assert.equal(clean.englishSelectedId, '9215159')
  assert.equal(clean.englishSelectedScore, 11120)
  assert.equal(clean.englishSelectionStable, true)
  assert.deepEqual(clean.englishTop, ['1:9215159:11120', '2:9215154:10200'])
})
