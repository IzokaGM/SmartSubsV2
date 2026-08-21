'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  translateTexts,
  translateIndexedItems,
  aggregateTranslationStats
} = require('../src/translator')

function geminiBody(translations) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ translations }) }] } }]
  }
}

test('M11 recovers a missing cue by retrying only the missing id', async () => {
  const texts = Array.from({ length: 180 }, (_, id) => `English ${id}`)
  const calls = []
  let requestNo = 0

  const fetchImpl = async (_url, init) => {
    requestNo++
    const body = JSON.parse(init.body)
    const prompt = body.contents[0].parts[0].text
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
    calls.push(payload.map(item => item.id))

    const translations = requestNo === 1
      ? payload.filter(item => item.id !== 77).map(item => ({ id: item.id, text: `BM ${item.id}` }))
      : payload.map(item => ({ id: item.id, text: `BM ${item.id}` }))

    return { ok: true, status: 200, json: async () => geminiBody(translations) }
  }

  let stats
  const output = await translateTexts(texts, {
    apiKey: 'fake',
    model: 'gemini-test',
    fetchImpl,
    retries: 0,
    semanticRetries: 1,
    onTranslationStats: value => { stats = value }
  })

  assert.equal(output.length, 180)
  assert.equal(output[76], 'BM 76')
  assert.equal(output[77], 'BM 77')
  assert.equal(output[78], 'BM 78')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].length, 180)
  assert.deepEqual(calls[1], [77])
  assert.deepEqual(stats, {
    expected: 180,
    received: 179,
    missing: 1,
    retryRecovered: 1,
    fallbackCount: 0,
    final: 180,
    semanticRetriesUsed: 1
  })
})

test('M11 maps shuffled Gemini output by id instead of array position', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => geminiBody([
      { id: 2, text: 'BM C' },
      { id: 0, text: 'BM A' },
      { id: 1, text: 'BM B' }
    ])
  })

  const output = await translateTexts(['A', 'B', 'C'], {
    apiKey: 'fake', model: 'gemini-test', fetchImpl, retries: 0, semanticRetries: 0
  })
  assert.deepEqual(output, ['BM A', 'BM B', 'BM C'])
})

test('M11 falls back only the still-missing cue after semantic retry', async () => {
  let call = 0
  const fetchImpl = async () => {
    call++
    return {
      ok: true,
      status: 200,
      json: async () => call === 1
        ? geminiBody([{ id: 0, text: 'BM A' }, { id: 2, text: 'BM C' }])
        : geminiBody([])
    }
  }

  let stats
  const output = await translateTexts(['A', 'B', 'C'], {
    apiKey: 'fake', model: 'gemini-test', fetchImpl, retries: 0, semanticRetries: 1,
    onTranslationStats: value => { stats = value }
  })

  assert.deepEqual(output, ['BM A', 'B', 'BM C'])
  assert.equal(stats.missing, 1)
  assert.equal(stats.retryRecovered, 0)
  assert.equal(stats.fallbackCount, 1)
  assert.equal(stats.final, 3)
})

test('M11 does not silently return all-English when Gemini returns no usable cues', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => geminiBody([]) })
  await assert.rejects(
    translateIndexedItems([{ id: 0, text: 'A' }, { id: 1, text: 'B' }], {
      apiKey: 'fake', model: 'gemini-test', fetchImpl, retries: 0, semanticRetries: 1
    }),
    /no usable translated cues/i
  )
})

test('M11 aggregates repair stats across chunks', () => {
  assert.deepEqual(aggregateTranslationStats([
    { received: 179, missing: 1, retryRecovered: 1, fallbackCount: 0, final: 180, semanticRetriesUsed: 1 },
    { received: 20, missing: 0, retryRecovered: 0, fallbackCount: 0, final: 20, semanticRetriesUsed: 0 }
  ], 200), {
    expected: 200,
    received: 199,
    missing: 1,
    retryRecovered: 1,
    fallbackCount: 0,
    final: 200,
    semanticRetriesUsed: 1,
    chunks: 2
  })
})

test('M11 Cloudflare cache returns translation repair stats on a cache miss', async () => {
  const { cfGetOrTranslate } = await import('../src/cf-cache.mjs')
  const values = new Map()
  const cache = {
    version: 'm11-test',
    async get(key) { return values.get(key) || null },
    async set(key, value) { values.set(key, value) }
  }
  const result = await cfGetOrTranslate({
    cache,
    upstreamUrl: 'https://example.test/sub.vtt',
    sourceId: 'sub-1',
    model: 'gemini-test',
    apiKey: 'fake',
    translateFn: async (_url, options) => {
      await options.onTranslationStats({
        expected: 180, received: 179, missing: 1,
        retryRecovered: 1, fallbackCount: 0, final: 180,
        semanticRetriesUsed: 1, chunks: 1
      })
      return 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHai\n'
    }
  })
  assert.equal(result.status, 'MISS')
  assert.equal(result.translationStats.missing, 1)
  assert.equal(result.translationStats.retryRecovered, 1)
  assert.equal(result.translationStats.final, 180)
})
