'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { buildAutoSubtitle } = require('../src/subtitles')

test('Gemini track ID exposes the selected upstream subtitle ID', () => {
  const result = buildAutoSubtitle(
    { id: 10341915, lang: 'eng', url: 'https://example.test/source.srt' },
    { publicBaseUrl: 'https://smartsubs.example', tokenSecret: 'test-secret' }
  )
  assert.equal(result.id, 'gemini-ai-10341915')
})

test('Gemini track ID falls back to a stable source URL hash when upstream ID is missing', () => {
  const sourceUrl = 'https://example.test/no-id.srt'
  const result = buildAutoSubtitle(
    { lang: 'eng', url: sourceUrl },
    { publicBaseUrl: 'https://smartsubs.example', tokenSecret: 'test-secret' }
  )
  const shortId = crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12)
  assert.equal(result.id, `gemini-ai-${shortId}`)
})
