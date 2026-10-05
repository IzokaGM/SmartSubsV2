'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildIndexedPrompt, requestGemini, translateCues,
  translateIndexedItems
} = require('../src/translator')
const { sanitiseEvent } = require('../src/diagnostics')

const source = [{ id: 17, text: 'Where is your brother?' }, { id: 18, text: 'He went home.' }]
const responseBody = (translations, finishReason = 'STOP', tokenCount = 54, inputTokens = 30) => ({
  candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify({ translations }) }] } }],
  usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: tokenCount, totalTokenCount: inputTokens + tokenCount }
})

test('structured prompt keeps Bahasa Melayu Malaysia, cue integrity and JSON output', () => {
  const text = buildIndexedPrompt(source)
  assert.match(text, /^You are a subtitle translator\./)
  assert.match(text, /\nTask:\n/)
  assert.match(text, /\nTranslation rules:\n/)
  assert.match(text, /Bahasa Melayu Malaysia/)
  assert.match(text, /meaning, intent, tone, emotion/)
  assert.match(text, /speaker labels, formatting tags and meaningful markup/)
  assert.match(text, /never use Indonesian vocabulary or sentence patterns/)
  assert.match(text, /culturally or religiously specific meaning/)
  assert.match(text, /\nOutput rules:\n/)
  assert.match(text, /exactly one non-empty translation for every input id/)
  assert.match(text, /Preserve ids and order/)
  assert.deepEqual(JSON.parse(text.split('\n').at(-1)), source)
})

test('records finish reason and candidate output tokens on successful response without changing Gemini settings', async () => {
  const metrics = {}
  let generationConfig
  const body = responseBody([{ id: 17, text: 'Di mana abang awak?' }])
  const result = await requestGemini(buildIndexedPrompt(source.slice(0, 1)), {
    apiKey: 'fake-test-key', requestMetrics: metrics,
    fetchImpl: async (_url, init) => {
      generationConfig = JSON.parse(init.body).generationConfig
      return { ok: true, status: 200, json: async () => body }
    }
  })
  assert.equal(result, body)
  assert.equal(generationConfig.thinkingConfig.thinkingLevel, 'minimal')
  assert.equal(generationConfig.responseMimeType, 'application/json')
  assert.deepEqual(generationConfig.responseSchema.properties.translations.items.required, ['id', 'text'])
  assert.equal(generationConfig.maxOutputTokens, undefined)
  assert.deepEqual(metrics.geminiStatuses, [200])
  assert.deepEqual(metrics.geminiFinishReasons, ['STOP'])
  assert.deepEqual(metrics.geminiInputTokens, [30])
  assert.deepEqual(metrics.geminiOutputTokens, [54])
  assert.deepEqual(metrics.geminiTotalTokens, [84])
})

test('missing metadata, 503 and retry preserve one aligned entry per API attempt', async () => {
  const metrics = {}
  let calls = 0
  await requestGemini('hello', {
    apiKey: 'fake', retries: 1, retryBaseMs: 1, jitterFn: () => 0,
    sleepFn: async () => {}, requestMetrics: metrics,
    fetchImpl: async () => {
      calls++
      return calls === 1
        ? { ok: false, status: 503, headers: { get: () => null } }
        : { ok: true, status: 200, json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"translations":[]}' }] } }]
        }) }
    }
  })
  assert.deepEqual(metrics.geminiStatuses, [503, 200])
  assert.deepEqual(metrics.geminiFinishReasons, ['NA', 'NA'])
  assert.deepEqual(metrics.geminiInputTokens, ['NA', 'NA'])
  assert.deepEqual(metrics.geminiOutputTokens, ['NA', 'NA'])
  assert.deepEqual(metrics.geminiTotalTokens, ['NA', 'NA'])
  assert.equal(metrics.geminiCallMs.length, 2)
  assert.equal(metrics.geminiPromptChars.length, 2)
})

test('semantic retry retains only missing IDs and captures metadata for each call', async () => {
  const metrics = {}
  const prompts = []
  let calls = 0
  const result = await translateIndexedItems(source, {
    apiKey: 'fake', requestMetrics: metrics,
    fetchImpl: async (_url, init) => {
      const prompt = JSON.parse(init.body).contents[0].parts[0].text
      prompts.push(JSON.parse(prompt.split('\n').at(-1)))
      calls++
      return { ok: true, status: 200, json: async () =>
        calls === 1
          ? responseBody([{ id: 17, text: 'Di mana abang awak?' }], 'STOP', 21)
          : responseBody([{ id: 18, text: 'Dia sudah pulang.' }], 'STOP', 11)
      }
    }
  })
  assert.deepEqual(prompts.map(items => items.map(item => item.id)), [[17, 18], [18]])
  assert.deepEqual(result.translations, ['Di mana abang awak?', 'Dia sudah pulang.'])
  assert.equal(result.stats.retryRecovered, 1)
  assert.deepEqual(metrics.geminiOutputTokens, [21, 11])
})

test('performance snapshot and existing single diagnostic event safely include compact metadata', async () => {
  let result
  const cues = [{ time: '00:00:01.000 --> 00:00:02.000', text: 'Hello' }]
  await translateCues(cues, {
    maxItems: 1, concurrency: 1, apiKey: 'fake',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () =>
      responseBody([{ id: 0, text: 'Hai' }], 'STOP', 9)
    }),
    onTranslationStats: stats => { result = stats }
  })
  assert.deepEqual(result.geminiFinishReasons, ['STOP'])
  assert.deepEqual(result.geminiInputTokens, [30])
  assert.deepEqual(result.geminiOutputTokens, [9])
  assert.deepEqual(result.geminiTotalTokens, [39])
  const diagnostic = sanitiseEvent({
    event: 'queue-translation-complete',
    geminiFinishReasons: result.geminiFinishReasons,
    geminiInputTokens: result.geminiInputTokens,
    geminiOutputTokens: result.geminiOutputTokens,
    geminiTotalTokens: result.geminiTotalTokens
  })
  assert.deepEqual(diagnostic.geminiFinishReasons, ['STOP'])
  assert.deepEqual(diagnostic.geminiInputTokens, ['30'])
  assert.deepEqual(diagnostic.geminiOutputTokens, ['9'])
  assert.deepEqual(diagnostic.geminiTotalTokens, ['39'])
  assert.equal(diagnostic.event, 'queue-translation-complete')
  assert.equal(Object.hasOwn(diagnostic, 'translations'), false)
})
