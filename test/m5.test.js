'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createTranslationToken, decodeTranslationToken } = require('../src/token')
const { parseTimedCues, translateTexts, cuesToVtt } = require('../src/translator')
const { buildAutoSubtitle } = require('../src/subtitles')

test('M5 signs and verifies translation URLs', () => {
  const secret = 'test-secret'
  const source = 'https://example.com/subtitle.srt?x=1'
  const token = createTranslationToken(source, secret)
  assert.equal(decodeTranslationToken(token, secret), source)
  assert.throws(() => decodeTranslationToken(`${token}x`, secret))
})

test('M5 parses SRT timestamps and emits valid WebVTT shell', () => {
  const source = `1\n00:00:01,000 --> 00:00:03,500\nHello there.\n\n2\n00:00:04,000 --> 00:00:05,000\nHow are you?\n`
  const cues = parseTimedCues(source)
  assert.equal(cues.length, 2)
  assert.equal(cues[0].time, '00:00:01.000 --> 00:00:03.500')
  assert.match(cuesToVtt(cues), /^WEBVTT/)
})

test('M5 calls Gemini with API key header and consumes structured translations', async () => {
  let seenHeader = null
  const fakeFetch = async (_url, init) => {
    seenHeader = init.headers['x-goog-api-key']
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: ['Hai.', 'Apa khabar?'] }) }] } }]
      })
    }
  }
  const output = await translateTexts(['Hi.', 'How are you?'], {
    apiKey: 'fake-key',
    model: 'gemini-test',
    fetchImpl: fakeFetch
  })

  assert.equal(seenHeader, 'fake-key')
  assert.deepEqual(output, ['Hai.', 'Apa khabar?'])
})

test('M5 creates Malay auto subtitle using standard Malay language code', () => {
  const result = buildAutoSubtitle(
    { id: 'eng1', lang: 'eng', url: 'https://example.com/en.srt' },
    { publicBaseUrl: 'https://smartsubs.example', tokenSecret: 'secret-value' }
  )
  assert.equal(result.lang, 'msa')
  assert.match(result.url, /^https:\/\/smartsubs\.example\/translated\/.+\.vtt$/)
  assert.equal(result.url.includes('secret-value'), false)
})
