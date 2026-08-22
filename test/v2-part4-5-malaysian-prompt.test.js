'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildIndexedPrompt } = require('../src/translator')

test('Part 4.5 requests natural Malaysian Malay with explicit locale controls', () => {
  const prompt = buildIndexedPrompt([{ id: 0, text: 'Are you kidding me?' }])

  assert.match(prompt, /Malaysian Bahasa Melayu/)
  assert.match(prompt, /Avoid unintended Indonesian vocabulary/)
  assert.match(prompt, /saya, awak, anda, aku, kau, kami and kita/)
  assert.match(prompt, /without censoring or exaggerating/)
  assert.match(prompt, /concise and comfortable to read as subtitles/)
})

test('Part 4.5 preserves structured cue ids and appends the input JSON unchanged', () => {
  const items = [
    { id: 17, text: 'Hello, <i>John</i>.' },
    { id: 23, text: '[door closes]\nWait!' }
  ]
  const prompt = buildIndexedPrompt(items)
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))

  assert.deepEqual(payload, items)
  assert.match(prompt, /exactly one translated object with the SAME id/)
  assert.match(prompt, /Never renumber, merge, split, duplicate or omit ids/)
})

test('Part 4.5 keeps the fixed prompt instructions compact', () => {
  const promptWithoutCues = buildIndexedPrompt([])
  assert.ok(promptWithoutCues.length < 2500)
})
