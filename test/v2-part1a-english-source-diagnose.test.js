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

test('Direct English selection uses first eligible OpenSubtitles source regardless of release metadata', async () => {
  const upstream = [
    { id:'first', lang:'eng', url:'https://example.test/BluRay.srt' },
    { id:'second', lang:'eng', url:'https://example.test/WEB-DL.srt' }
  ]
  const events=[]
  const result=await handleSubtitles({type:'series',id:'tt11198330:1:1',extra:{filename:'WEB-DL.mkv'}}, {
    apiKey:'key',publicBaseUrl:'https://smartsubs.example/c/test',tokenSecret:'test-secret',
    fetchImpl:responseFor(upstream),onDiagnostic: async event=>events.push(event)
  })
  const event=events.find(item=>item.event==='subtitle-result')
  assert.equal(result.subtitles.length,1)
  assert.equal(event.englishSelectedId,'first')
  assert.deepEqual(event.englishSourceIds,['first','second'])
  assert.equal(event.englishCandidateCount,2)
  assert.equal('englishSelectedScore' in event,false)
  assert.equal('englishConfidence' in event,false)
})

test('Direct English selection skips missing URLs and preserves remaining order', () => {
  const upstream=[{id:'unusable',lang:'eng'},
    {id:'first',lang:'eng',url:'https://example.test/first.srt'},
    {id:'second',lang:'eng',url:'https://example.test/second.srt'}]
  const info=englishSelectionDiagnostics(upstream, upstream[1], {})
  assert.equal(info.englishSelectedId,'first')
  assert.deepEqual(info.englishSourceIds,['first','second'])
  assert.equal(info.englishCandidateCount,2)
  assert.equal('sourceVideoHashProvided' in info,false)
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
