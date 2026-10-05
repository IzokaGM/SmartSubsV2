'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  cleanSdhCueText,
  prepareCuesForTranslation,
  translateCues,
  translateSubtitleUrl
} = require('../src/translator')
const { sanitiseEvent } = require('../src/diagnostics')

function responseBody(text = 'BM', inputTokens = 10, outputTokens = 20) {
  return {
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [{ text: JSON.stringify({ translations: [{ id: 0, text }] }) }] }
    }],
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens
    }
  }
}

test('SDH cleaner removes sound/music descriptions but preserves speaker labels', () => {
  assert.deepEqual(cleanSdhCueText('[panting]'), { text: '', removed: 1 })
  assert.deepEqual(cleanSdhCueText('[slow suspenseful music playing]'), { text: '', removed: 1 })
  assert.deepEqual(cleanSdhCueText('[door closes]'), { text: '', removed: 1 })
  assert.deepEqual(
    cleanSdhCueText('[VILLAGER 1B]\nYes, that is right.'),
    { text: '[VILLAGER 1B]\nYes, that is right.', removed: 0 }
  )
  assert.deepEqual(
    cleanSdhCueText('[sighs] I do not know.'),
    { text: 'I do not know.', removed: 1 }
  )
})

test('SDH preparation drops description-only cues and keeps dialogue timing intact', () => {
  const prepared = prepareCuesForTranslation([
    { time: '00:00:01.000 --> 00:00:02.000', text: '[panting]' },
    { time: '00:00:03.000 --> 00:00:04.000', text: '[VILLAGER 1B]\nYes.' },
    { time: '00:00:05.000 --> 00:00:06.000', text: '[sighs] I do not know.' }
  ])

  assert.equal(prepared.sdhRemoved, 2)
  assert.deepEqual(prepared.cues, [
    { time: '00:00:03.000 --> 00:00:04.000', text: '[VILLAGER 1B]\nYes.' },
    { time: '00:00:05.000 --> 00:00:06.000', text: 'I do not know.' }
  ])
})

test('subtitle pipeline does not send SDH-only cues to translation and reports sdhRemoved', async () => {
  const source = `WEBVTT

00:00:01.000 --> 00:00:02.000
[panting]

00:00:03.000 --> 00:00:04.000
[slow suspenseful music playing]

00:00:05.000 --> 00:00:06.000
[VILLAGER 1B]
Yes, that is right.

00:00:07.000 --> 00:00:08.000
[sighs] I do not know.
`
  const seen = []
  let stats
  const vtt = await translateSubtitleUrl('https://example.invalid/sub.vtt', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(source)
    }),
    translateTextsFn: async (texts, options) => {
      seen.push(...texts)
      await options.onTranslationStats?.({
        expected: texts.length,
        received: texts.length,
        missing: 0,
        retryRecovered: 0,
        fallbackCount: 0,
        final: texts.length,
        semanticRetriesUsed: 0
      })
      return texts.map(text => `BM:${text}`)
    },
    onTranslationStats: value => { stats = value }
  })

  assert.deepEqual(seen, [
    '[VILLAGER 1B]\nYes, that is right.',
    'I do not know.'
  ])
  assert.equal(stats.cueCount, 4)
  assert.equal(stats.expected, 2)
  assert.equal(stats.sdhRemoved, 3)
  assert.doesNotMatch(vtt, /panting|suspenseful music/)
  assert.match(vtt, /\[VILLAGER 1B\]/)
  assert.match(vtt, /I do not know\./)
})

test('token diagnostics keep every Gemini call and expose exact totals', async () => {
  const cues = Array.from({ length: 12 }, (_, index) => ({
    time: `00:00:${String(index).padStart(2, '0')}.000 --> 00:00:59.000`,
    text: `line-${index}`
  }))
  let stats

  await translateCues(cues, {
    maxItems: 1,
    maxChars: 20000,
    concurrency: 5,
    apiKey: 'fake',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => responseBody()
    }),
    onTranslationStats: value => { stats = value }
  })

  assert.equal(stats.geminiCalls, 12)
  assert.equal(stats.geminiInputTokens.length, 12)
  assert.equal(stats.geminiOutputTokens.length, 12)
  assert.equal(stats.geminiTotalTokens.length, 12)
  assert.equal(stats.geminiInputTokensTotal, 120)
  assert.equal(stats.geminiOutputTokensTotal, 240)
  assert.equal(stats.geminiTotalTokensTotal, 360)

  const diagnostic = sanitiseEvent({
    event: 'queue-translation-complete',
    geminiCallMs: stats.geminiCallMs,
    geminiStatuses: stats.geminiStatuses,
    geminiPromptChars: stats.geminiPromptChars,
    geminiFinishReasons: stats.geminiFinishReasons,
    geminiInputTokens: stats.geminiInputTokens,
    geminiOutputTokens: stats.geminiOutputTokens,
    geminiTotalTokens: stats.geminiTotalTokens,
    geminiInputTokensTotal: stats.geminiInputTokensTotal,
    geminiOutputTokensTotal: stats.geminiOutputTokensTotal,
    geminiTotalTokensTotal: stats.geminiTotalTokensTotal,
    sdhRemoved: 7
  })

  assert.equal(diagnostic.geminiInputTokens.length, 12)
  assert.equal(diagnostic.geminiOutputTokens.length, 12)
  assert.equal(diagnostic.geminiTotalTokens.length, 12)
  assert.equal(diagnostic.geminiInputTokensTotal, 120)
  assert.equal(diagnostic.geminiOutputTokensTotal, 240)
  assert.equal(diagnostic.geminiTotalTokensTotal, 360)
  assert.equal(diagnostic.sdhRemoved, 7)
})
