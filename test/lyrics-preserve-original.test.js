'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isMarkedLyricLine,
  prepareCuesForTranslation,
  translateCues,
  translateSubtitleUrl,
  cuesToVtt
} = require('../src/translator')

const at = (second, text) => ({
  time: `00:00:${String(second).padStart(2, '0')}.000 --> 00:00:${String(second + 1).padStart(2, '0')}.000`,
  text
})

function mockTranslation(seen) {
  return async (texts, options) => {
    seen.push(...texts)
    await options.onTranslationStats?.({
      expected: texts.length, received: texts.length, missing: 0,
      retryRecovered: 0, fallbackCount: 0, final: texts.length
    })
    return texts.map(text => `BM:${text}`)
  }
}

test('recognises explicit music notes but not background music, italic speech or an embedded note', () => {
  assert.equal(isMarkedLyricLine('♪ Never gonna give you up ♪'), true)
  assert.equal(isMarkedLyricLine('<i>♫ I will always love you ♫</i>'), true)
  assert.equal(isMarkedLyricLine('{\\an8}- ♪ Hold on'), true)
  assert.equal(isMarkedLyricLine('[SINGER] ♬ Love me ♬'), true)
  assert.equal(isMarkedLyricLine('I love you ♪'), true)
  assert.equal(isMarkedLyricLine('<i>How are you?</i>'), false)
  assert.equal(isMarkedLyricLine('[music playing]'), false)
  assert.equal(isMarkedLyricLine('The ♪ symbol means a note.'), false)
  assert.equal(isMarkedLyricLine('♪ Sing this ♪ - What are you doing?'), false)
  assert.equal(isMarkedLyricLine('What are you doing? ♪ Sing this ♪'), false)
  assert.equal(isMarkedLyricLine('Never gonna give you up'), false)
})

test('lyrics-only cues bypass Gemini completely without dropping timing or music symbols', async () => {
  const cues = [at(1, '♪ Never gonna give you up ♪'), at(2, '<i>♫ I will always love you ♫</i>')]
  const seen = []
  let stats
  const result = await translateCues(cues, {
    translateTextsFn: mockTranslation(seen), onTranslationStats: value => { stats = value }
  })
  assert.deepEqual(seen, [])
  assert.deepEqual(result, cues)
  assert.equal(stats.geminiCalls, 0)
  assert.equal(stats.expected, 0)
  assert.equal(stats.chunks, 0)
  assert.equal(stats.lyricLinesSkipped, 2)
  assert.match(cuesToVtt(result), /♪ Never gonna give you up ♪/)
})

test('only spoken lines from mixed lyric/dialogue cues reach Gemini; original order stays intact', async () => {
  const input = [
    at(1, '♪ First original lyric ♪\nWhat are you doing?'),
    at(2, 'I am speaking.\n♫ Another lyric ♫\nAre you listening?'),
    at(3, 'Just speech.'),
    at(4, '♫ Song only ♫')
  ]
  const seen = []
  let stats
  const result = await translateCues(input, {
    maxItems: 2, concurrency: 2,
    translateTextsFn: mockTranslation(seen), onTranslationStats: value => { stats = value }
  })
  assert.deepEqual(seen, [
    'What are you doing?', 'I am speaking.', 'Are you listening?', 'Just speech.'
  ])
  assert.deepEqual(result.map(row => row.text), [
    '♪ First original lyric ♪\nBM:What are you doing?',
    'BM:I am speaking.\n♫ Another lyric ♫\nBM:Are you listening?',
    'BM:Just speech.',
    '♫ Song only ♫'
  ])
  assert.deepEqual(result.map(row => row.time), input.map(row => row.time))
  assert.equal(stats.expected, 4)
  assert.equal(stats.lyricLinesSkipped, 3)
})

test('standalone inline [singing] marker is a lyric, but speech with music cues remains spoken', async () => {
  const input = prepareCuesForTranslation([
    at(1, '[singing] Somewhere over the rainbow'),
    at(2, '[music playing] How are you?'),
    at(3, '[SINGER] Ready to begin.'),
    at(4, '[slow music playing]')
  ])
  const seen = []
  const result = await translateCues(input.cues, { translateTextsFn: mockTranslation(seen) })
  assert.deepEqual(seen, ['How are you?', '[SINGER] Ready to begin.'])
  assert.deepEqual(result.map(row => row.text), [
    'Somewhere over the rainbow', 'BM:How are you?', 'BM:[SINGER] Ready to begin.'
  ])
  assert.equal(input.sdhRemoved, 3)
})

test('real subtitle URL path excludes marked lyrics from Gemini and strips ASS tags', async () => {
  const source = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{\\an8}<i>♪ Don't stop believing ♪</i>\n\n00:00:03.000 --> 00:00:04.000\nWhere are you?\n\n00:00:05.000 --> 00:00:06.000\n- ♫ My heart ♫\n- Stay here.\n`
  const seen = []
  let stats
  const result = await translateSubtitleUrl('https://example.invalid/sub.vtt', {
    fetchImpl: async () => ({
      ok: true, status: 200, headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(source)
    }),
    translateTextsFn: mockTranslation(seen),
    onTranslationStats: value => { stats = value }
  })
  assert.deepEqual(seen, ['Where are you?', '- Stay here.'])
  assert.match(result, /<i>♪ Don't stop believing ♪<\/i>/)
  assert.match(result, /- ♫ My heart ♫\nBM:- Stay here\./)
  assert.match(result, /00:00:05\.000 --> 00:00:06\.000/)
  assert.doesNotMatch(result, /an8/)
  assert.equal(stats.lyricLinesSkipped, 2)
  assert.equal(stats.cueCount, 3)
})

test('without strong lyric evidence, dialogue still goes through the unchanged translation path', async () => {
  const cues = [at(1, '<i>I am going home.</i>'), at(2, 'Never gonna give you up')]
  const seen = []
  const result = await translateCues(cues, { maxItems: 2, translateTextsFn: mockTranslation(seen) })
  assert.deepEqual(seen, cues.map(row => row.text))
  assert.deepEqual(result.map(row => row.text), cues.map(row => `BM:${row.text}`))
})

test('when translating dialogue fails, no partial lyric/dialogue VTT is returned', async () => {
  await assert.rejects(translateCues([at(1, '♪ Song ♪\nHelp me.')], {
    translateTextsFn: async () => { throw new Error('Gemini HTTP 503') }
  }), /Gemini HTTP 503/)
})
