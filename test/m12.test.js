'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  scoreEnglishSubtitle,
  rankEnglishSubtitles,
  selectBestEnglish,
  releaseGroup
} = require('../src/selector')

function sub(id, extra = {}) {
  return {
    id,
    lang: 'eng',
    url: `https://example.test/${encodeURIComponent(id)}.srt`,
    ...extra
  }
}

test('M12 release group parser recognises common scene style filenames', () => {
  assert.equal(releaseGroup('Movie.2026.1080p.WEB-DL.x265-GROUP.mkv'), 'group')
  assert.equal(releaseGroup('https://cdn.test/Movie.2026.1080p.WEB-DL-GRP.srt?x=1'), 'grp')
})

test('M12 prefers candidate matching stream release metadata over upstream order', () => {
  const subtitles = [
    sub('first', { file_name: 'Movie.2026.1080p.BluRay.x264-OTHER.srt' }),
    sub('matching', { file_name: 'Movie.2026.1080p.WEB-DL.x265-GROUP.srt' }),
    sub('third', { file_name: 'Movie.2026.720p.WEBRip.x264-ALT.srt' })
  ]

  const selected = selectBestEnglish(subtitles, {
    filename: 'Movie.2026.1080p.WEB-DL.x265-GROUP.mkv'
  })

  assert.equal(selected.id, 'matching')
})

test('M12 exact video hash wins when OpenSubtitles metadata exposes the hash', () => {
  const subtitles = [
    sub('filename-match', { file_name: 'Movie.2026.1080p.WEB-DL.x265-GROUP.srt' }),
    sub('hash-match', {
      file_name: 'Movie.2026.720p.WEBRip.x264-OTHER.srt',
      moviehash: 'ABCDEF1234567890'
    })
  ]

  const selected = selectBestEnglish(subtitles, {
    filename: 'Movie.2026.1080p.WEB-DL.x265-GROUP.mkv',
    videoHash: 'ABCDEF1234567890'
  })

  assert.equal(selected.id, 'hash-match')
})

test('M12 still avoids forced, SDH and commentary subtitles without stream metadata', () => {
  const subtitles = [
    sub('movie-forced'),
    sub('movie-commentary'),
    sub('movie-sdh'),
    sub('movie-normal')
  ]
  assert.equal(selectBestEnglish(subtitles).id, 'movie-normal')
})

test('M12 ranking is deterministic and does not mutate subtitle objects', () => {
  const subtitles = [
    sub('a', { file_name: 'Movie.1080p.WEB-DL.x265-GRP.srt' }),
    sub('b', { file_name: 'Movie.1080p.BluRay.x264-OTHER.srt' })
  ]
  const before = JSON.stringify(subtitles)
  const ranked = rankEnglishSubtitles(subtitles, { filename: 'Movie.1080p.WEB-DL.x265-GRP.mkv' })
  assert.equal(ranked[0].subtitle.id, 'a')
  assert.equal(JSON.stringify(subtitles), before)
  assert.ok(
    scoreEnglishSubtitle(subtitles[0], 0, { filename: 'Movie.1080p.WEB-DL.x265-GRP.mkv' }) >
    scoreEnglishSubtitle(subtitles[1], 1, { filename: 'Movie.1080p.WEB-DL.x265-GRP.mkv' })
  )
})
