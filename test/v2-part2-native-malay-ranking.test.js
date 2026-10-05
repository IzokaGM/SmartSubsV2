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

test('Native Malay keeps original OpenSubtitles order without scoring, even with filename', async () => {
  const upstream=[
    {id:'native-first',lang:'ms',url:'https://example.test/Show.BluRay.srt'},
    {id:'native-second',lang:'msa',url:'https://example.test/Show.WEB-DL.srt'},
    {id:'english-first',lang:'eng',url:'https://example.test/Show.eng.srt'}]
  const events=[]
  const result=await handleSubtitles({type:'series',id:'tt11198330:1:1',extra:{filename:'Show.WEB-DL.mkv'}},
    {fetchImpl:responseFor(upstream),onDiagnostic:async e=>events.push(e)})
  assert.deepEqual(result.subtitles.map(s=>s.id),['native-first','native-second'])
  const event=events.find(e=>e.event==='subtitle-result')
  assert.equal(event.result,'native-malay')
  assert.equal(event.malayCount,2)
  assert.equal('malaySelectedScore' in event,false)
})

test('Malay AI uses first eligible English source regardless of filename matching', async () => {
  const upstream=[{id:'english-first',lang:'eng',url:'https://example.test/Show.BluRay.srt'},
    {id:'english-second',lang:'eng',url:'https://example.test/Show.WEB-DL.srt'}]
  const events=[]
  const result=await handleSubtitles({type:'series',id:'tt11198330:1:1',extra:{filename:'Show.WEB-DL.mkv'}},
    {apiKey:'key',publicBaseUrl:'https://smartsubs.example/c/test',tokenSecret:'test-secret',
      fetchImpl:responseFor(upstream),onDiagnostic:async e=>events.push(e)})
  assert.equal(result.subtitles.length,1)
  const event=events.find(e=>e.event==='subtitle-result')
  assert.equal(event.result,'auto-malay-ready')
  assert.equal(event.englishSelectedId,'english-first')
  assert.deepEqual(event.englishSourceIds,['english-first','english-second'])
  assert.equal(result.autoPrefetch,true)
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
