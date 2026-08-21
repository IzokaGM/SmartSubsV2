'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitiseEvent, deriveVerdict } = require('../src/diagnostics')

test('Nuvio diagnose never keeps URLs, API keys or unknown fields', () => {
  const clean = sanitiseEvent({
    event: 'subtitle-result',
    id: 'tt1375666',
    result: 'auto-malay-ready',
    englishFound: true,
    autoReady: true,
    subtitleCount: 1,
    upstreamUrl: 'https://private.example/sub.srt?token=secret',
    apiKey: 'fake-secret-key'
  })
  assert.equal(clean.id, 'tt1375666')
  assert.equal(clean.upstreamUrl, undefined)
  assert.equal(clean.apiKey, undefined)
})

test('Nuvio diagnose identifies no request and auto subtitle waiting for player', () => {
  assert.equal(deriveVerdict([]), 'NO_SUBTITLE_REQUEST_SEEN')
  assert.equal(deriveVerdict([{
    ts: 100,
    event: 'subtitle-result',
    result: 'auto-malay-ready',
    englishFound: true,
    byokConfigured: true,
    autoReady: true,
    subtitleCount: 1
  }]), 'SUBTITLE_RETURNED_WAITING_FOR_PLAYER_SELECTION')
})

test('Nuvio diagnose identifies delivered and failed translation', () => {
  const base = [{ ts: 100, event: 'subtitle-result', result: 'auto-malay-ready', autoReady: true, subtitleCount: 1 }]
  assert.equal(deriveVerdict([...base, { ts: 110, event: 'translation-delivered' }]), 'TRANSLATION_DELIVERED')
  assert.equal(deriveVerdict([...base, { ts: 110, event: 'translation-failed' }]), 'TRANSLATION_FAILED')
})
