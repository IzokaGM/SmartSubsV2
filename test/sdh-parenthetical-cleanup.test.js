'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  cleanSdhCueText, prepareCuesForTranslation, translateSubtitleUrl, cuesToVtt
} = require('../src/translator')

const at = (second, text) => ({
  time: `00:00:${String(second).padStart(2, '0')}.000 --> 00:00:${String(second + 1).padStart(2, '0')}.000`,
  text
})

const fetchVtt = source => async () => ({
  ok: true, status: 200, headers: { get: () => null },
  arrayBuffer: async () => Buffer.from(source)
})

const translateMock = seen => async (texts, options) => {
  seen.push(...texts)
  await options.onTranslationStats?.({ expected: texts.length, received: texts.length,
    missing: 0, retryRecovered: 0, fallbackCount: 0, final: texts.length })
  return texts.map(text => `BM:${text}`)
}

test('removes English vocal actions in parentheses, even within the spoken cue', () => {
  assert.deepEqual(
    cleanSdhCueText('Money... (sighs)\n...compliments and free clothes. (chuckles)'),
    { text: 'Money...\n...compliments and free clothes.', removed: 2 }
  )
  assert.deepEqual(cleanSdhCueText('(sighs, chuckles) I am fine.'),
    { text: 'I am fine.', removed: 1 })
  assert.deepEqual(cleanSdhCueText('He left. (laughs softly)'),
    { text: 'He left.', removed: 1 })
  assert.deepEqual(cleanSdhCueText('<i>(sighs)</i> Go now.'),
    { text: 'Go now.', removed: 1 })
})

test('removes recognisable sound effects but does not remove parenthetical speech', () => {
  assert.deepEqual(cleanSdhCueText('(door slams)\nWait!'),
    { text: 'Wait!', removed: 1 })
  assert.deepEqual(cleanSdhCueText('[applause]\n(music playing)\nHello.'),
    { text: 'Hello.', removed: 2 })
  for (const spoken of [
    '(in five minutes)', '(I laugh when I am nervous)', '(You should laugh)',
    '(music matters to me)', '(I love music)', '(Get out!)', '(123)',
    '(laugh at me)', '(ketawa itu bagus)', '[VILLAGER 1B]'
  ]) {
    assert.deepEqual(cleanSdhCueText(spoken), { text: spoken, removed: 0 }, spoken)
  }
})

test('drops SDH-only cues; retains all spoken timestamps and does not send SDH to Gemini', async () => {
  const source = `WEBVTT

00:00:01.000 --> 00:00:02.000
(sighs)

00:00:03.000 --> 00:00:04.000
Money... (sighs)
...compliments and free clothes. (chuckles)

00:00:05.000 --> 00:00:06.000
(door slams)

00:00:07.000 --> 00:00:08.000
(in five minutes)

00:00:09.000 --> 00:00:10.000
♪ Original lyrics ♪
[applause]
`
  const seen = []
  let stats
  const vtt = await translateSubtitleUrl('https://example.invalid/sub.vtt', {
    fetchImpl: fetchVtt(source), translateTextsFn: translateMock(seen),
    onTranslationStats: next => { stats = next }
  })
  assert.deepEqual(seen, [
    'Money...\n...compliments and free clothes.', '(in five minutes)'
  ])
  assert.deepEqual(stats && [stats.cueCount, stats.sdhRemoved, stats.lyricLinesSkipped], [5, 5, 1])
  assert.match(vtt, /00:00:03\.000 --> 00:00:04\.000\nBM:Money\.\.\./)
  assert.match(vtt, /00:00:07\.000 --> 00:00:08\.000\nBM:\(in five minutes\)/)
  assert.match(vtt, /00:00:09\.000 --> 00:00:10\.000\n♪ Original lyrics ♪/)
  assert.doesNotMatch(vtt, /00:00:01\.000 -->|00:00:05\.000 -->|sighs|chuckles|applause/)
})

test('defensive VTT cleanup catches translated Malay SDH without deleting actual speech', () => {
  const output = cuesToVtt([
    at(1, 'Duit... (mengeluh)\n...pujian dan pakaian percuma. (ketawa kecil)'),
    at(3, '(mengeluh)'),
    at(5, 'Ini (lima minit) sahaja.'),
    at(7, '♪ Lagu asal ♪')
  ])
  assert.match(output, /Duit\.\.\.\n\.\.\.pujian dan pakaian percuma\./)
  assert.match(output, /Ini \(lima minit\) sahaja\./)
  assert.match(output, /♪ Lagu asal ♪/)
  assert.doesNotMatch(output, /\(mengeluh\)|\(ketawa kecil\)|00:00:03\.000 -->/)
})

test('lyrics explicitly labelled (singing) remain untranslated while action cues are removed', () => {
  const prepared = prepareCuesForTranslation([
    at(1, '(singing) Somewhere over the rainbow'),
    at(3, '(chuckles)'),
    at(5, '(sighs) No.')
  ])
  assert.equal(prepared.sdhRemoved, 3)
  assert.deepEqual(prepared.cues.map(cue => cue.text), ['Somewhere over the rainbow', 'No.'])
})
