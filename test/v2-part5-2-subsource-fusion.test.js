'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { zipSync, strToU8 } = require('fflate')
const {
  parseMediaId,
  selectMovie,
  normaliseSubsourceSubtitle,
  fetchSubsourceCandidates
} = require('../src/subsource')
const { extractSubtitleArchive, assToSrt } = require('../src/subsource-archive')
const { handleSubtitles } = require('../src/subtitles')
const { createUserConfigToken } = require('../src/user-config')
const { rankEnglishSubtitles } = require('../src/selector')

function memoryKv() {
  const values = new Map()
  return {
    values,
    async get(key, options = {}) {
      const value = values.get(String(key)) ?? null
      return options.type === 'json' && value ? JSON.parse(value) : value
    },
    async put(key, value) { values.set(String(key), String(value)) },
    async list(options = {}) {
      const prefix = String(options.prefix || '')
      return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })) }
    }
  }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('Part 5.2 parses Stremio IMDb episode identity and keeps the API key out of proxy URLs', () => {
  assert.deepEqual(parseMediaId({ id: 'tt10986410:2:7' }), {
    imdbId: 'tt10986410', season: 2, episode: 7
  })
  const subtitle = normaliseSubsourceSubtitle({
    subtitleId: 91,
    language: 'Malay',
    releaseInfo: ['Show.S02E07.1080p.WEB-DL.x265-GROUP'],
    downloads: 12
  }, 'https://smartsubsv2.example/c/encrypted-token', 2, 7)
  assert.equal(subtitle.lang, 'msa')
  assert.equal(subtitle.url, 'https://smartsubsv2.example/c/encrypted-token/subsource/91/2/7.srt')
  assert.equal(subtitle.url.includes('secret-api-key'), false)
  assert.equal(subtitle.downloads, 12)
})

test('Part 5.2 uses documented movie and subtitle endpoints and normalises Malay and English', async () => {
  const calls = []
  const result = await fetchSubsourceCandidates({ type: 'series', id: 'tt10986410:1:5' }, 'secret-api-key', {
    publicBaseUrl: 'https://smartsubsv2.example/c/token',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), key: options.headers['x-api-key'] })
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/movies/search')) {
        return response({ data: [{ movieId: 44, imdbId: 'tt10986410', season: 1, type: 'series', title: 'Example' }] })
      }
      const language = parsed.searchParams.get('language')
      return response({ data: [{
        subtitleId: language === 'malay' ? 101 : 102,
        movieId: 44,
        language,
        releaseInfo: ['Show.S01E05.1080p.WEB-DL.x265-GROUP']
      }] })
    }
  })
  assert.equal(calls.length, 3)
  assert.equal(calls.every(call => call.key === 'secret-api-key' && !call.url.includes('secret-api-key')), true)
  assert.deepEqual(result.candidates.map(item => item.lang).sort(), ['eng', 'msa'])
  assert.equal(result.candidates.every(item => item.url.includes('/subsource/')), true)
})

test('Part 5.2 ZIP extraction selects the requested episode and converts ASS safely', () => {
  const zip = zipSync({
    'Show.S01E01.srt': strToU8('1\n00:00:01,000 --> 00:00:02,000\nWrong episode\n'),
    'Show.S01E05.srt': strToU8('1\n00:00:01,000 --> 00:00:02,000\nCorrect episode\n')
  })
  const extracted = extractSubtitleArchive(zip, 1, 5)
  assert.equal(extracted.filename, 'Show.S01E05.srt')
  assert.match(extracted.text, /Correct episode/)
  assert.match(assToSrt('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello\\Nworld'), /00:00:01,000 --> 00:00:02,500/)
})

test('Part 5.2 uses bounded download and rating quality only after sync evidence', () => {
  const release = 'Movie.1080p.WEB-DL.x265-GROUP'
  const ranked = rankEnglishSubtitles([
    { id: 'low-quality', lang: 'eng', url: 'https://a', releaseInfo: [release], downloads: 2, rating: { good: 1, bad: 3 } },
    { id: 'high-quality', lang: 'eng', url: 'https://b', releaseInfo: [release], downloads: 5000, rating: { good: 18, bad: 2 } }
  ], { filename: `${release}.mkv` })
  assert.equal(ranked[0].subtitle.id, 'high-quality')
  assert.equal(ranked[0].confidence.level, 'STRONG')
})

test('Part 5.2 fuses SubSource into unified ranking only when current evidence is weak', async () => {
  const diagnostics = []
  let fusionCalls = 0
  const result = await handleSubtitles({
    type: 'series',
    id: 'tt10986410:1:5',
    extra: { filename: 'Show.S01E05.1080p.WEB-DL.x265-GROUP.mkv' }
  }, {
    apiKey: 'gemini-test',
    tokenSecret: 'token-secret',
    publicBaseUrl: 'https://smartsubsv2.example/c/token',
    includeEnglishTracks: true,
    subsourceApiKey: 'subsource-key',
    fetchImpl: async () => response({ subtitles: [{
      id: 'os-eng-weak', lang: 'eng', url: 'https://os.example/weak.srt', release: 'Other.Release'
    }] }),
    fetchSubsourceCandidatesFn: async () => {
      fusionCalls++
      return {
        status: 'connected', cache: 'MISS', latencyMs: 25,
        candidates: [
          { id: 'subsource-201', lang: 'msa', url: 'https://smartsubsv2.example/c/token/subsource/201/1/5.srt', provider: 'subsource', releaseInfo: ['Show.S01E05.1080p.WEB-DL.x265-GROUP'] },
          { id: 'subsource-202', lang: 'eng', url: 'https://smartsubsv2.example/c/token/subsource/202/1/5.srt', provider: 'subsource', releaseInfo: ['Show.S01E05.1080p.WEB-DL.x265-GROUP'] }
        ]
      }
    },
    onDiagnostic: event => diagnostics.push(event)
  })
  assert.equal(fusionCalls, 1)
  assert.equal(result.subtitles[0].id, 'subsource-201')
  assert.equal(result.subtitles[0].lang, 'msa')
  assert.equal(result.subtitles.some(item => item.lang === 'eng' && item.url.includes('/subsource/202/')), true)
  assert.equal(diagnostics.some(item => item.event === 'subsource-fusion' && item.subsourceCandidateCount === 2), true)
})

test('Part 5.2 skips SubSource when both native and English already have strong release evidence', async () => {
  let fusionCalls = 0
  const release = 'Show.S01E05.1080p.WEB-DL.x265-GROUP'
  await handleSubtitles({
    type: 'series', id: 'tt10986410:1:5', extra: { filename: `${release}.mkv` }
  }, {
    apiKey: 'gemini-test', tokenSecret: 'token-secret', publicBaseUrl: 'https://smartsubsv2.example/c/token',
    subsourceApiKey: 'subsource-key',
    fetchImpl: async () => response({ subtitles: [
      { id: 'os-msa', lang: 'msa', url: 'https://os.example/ms.srt', release },
      { id: 'os-eng', lang: 'eng', url: 'https://os.example/en.srt', release }
    ] }),
    fetchSubsourceCandidatesFn: async () => { fusionCalls++; return { candidates: [] } }
  })
  assert.equal(fusionCalls, 0)
})

test('Part 5.2 fails open to OpenSubtitles when SubSource is unavailable', async () => {
  const result = await handleSubtitles({ type: 'movie', id: 'tt1375666', extra: { filename: 'Movie.1080p.WEB-DL.mkv' } }, {
    apiKey: 'gemini-test', tokenSecret: 'token-secret', publicBaseUrl: 'https://smartsubsv2.example/c/token',
    includeEnglishTracks: true,
    subsourceApiKey: 'subsource-key',
    fetchImpl: async () => response({ subtitles: [{ id: 'os-eng', lang: 'eng', url: 'https://os.example/en.srt' }] }),
    fetchSubsourceCandidatesFn: async () => { throw new Error('SubSource subtitle search HTTP 429') }
  })
  assert.equal(result.subtitles.some(item => item.lang === 'eng' && item.url === 'https://os.example/en.srt'), true)
  assert.equal(result.subtitles.some(item => item.lang === 'msa'), true)
})

test('Part 5.2 can use strongly matched SubSource when OpenSubtitles itself is unavailable', async () => {
  const result = await handleSubtitles({ type: 'movie', id: 'tt1375666', extra: { filename: 'Movie.1080p.WEB-DL.mkv' } }, {
    apiKey: 'gemini-test', tokenSecret: 'token-secret', publicBaseUrl: 'https://smartsubsv2.example/c/token',
    includeEnglishTracks: true,
    subsourceApiKey: 'subsource-key',
    fetchImpl: async () => { throw new Error('OpenSubtitles v3 HTTP 503') },
    fetchSubsourceCandidatesFn: async () => ({
      cache: 'MISS', latencyMs: 12,
      candidates: [{ id: 'subsource-301', lang: 'eng', url: 'https://smartsubsv2.example/c/token/subsource/301/0/0.srt', provider: 'subsource', releaseInfo: ['Movie.1080p.WEB-DL'] }]
    })
  })
  assert.equal(result.subtitles.some(item => item.lang === 'eng' && item.url.includes('/subsource/301/')), true)
  assert.equal(result.subtitles.some(item => item.lang === 'msa'), true)
})

test('Part 5.2 opens a per-key quota circuit after HTTP 429', async () => {
  const kv = memoryKv()
  let calls = 0
  const options = {
    kv,
    publicBaseUrl: 'https://smartsubsv2.example/c/token',
    fetchImpl: async () => {
      calls++
      return new Response('{}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-ratelimit-reset': new Date(Date.now() + 60000).toISOString() }
      })
    }
  }
  await assert.rejects(fetchSubsourceCandidates({ type: 'movie', id: 'tt1375666' }, 'quota-key-a', options), /HTTP 429/)
  await assert.rejects(fetchSubsourceCandidates({ type: 'movie', id: 'tt1375666' }, 'quota-key-a', options), /circuit open HTTP 429/)
  assert.equal(calls, 1)
})

test('Part 5.2 Worker proxies and caches extracted subtitles without exposing the API key', async () => {
  const { handleRequest } = await import('../src/cloudflare-worker.mjs')
  const secret = 'worker-secret-part52'
  const apiKey = 'private-subsource-api-key'
  const token = createUserConfigToken('gemini-test-key', {
    secret,
    subsourceApiKey: apiKey,
    iv: Buffer.alloc(12, 4)
  })
  const kv = memoryKv()
  const archive = zipSync({
    'Movie.English.srt': strToU8('1\n00:00:01,000 --> 00:00:02,000\nHello\n')
  })
  const originalFetch = global.fetch
  let calls = 0
  global.fetch = async (url, options) => {
    calls++
    assert.equal(String(url), 'https://api.subsource.net/api/v1/subtitles/321/download')
    assert.equal(options.headers['x-api-key'], apiKey)
    assert.equal(String(url).includes(apiKey), false)
    return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } })
  }
  try {
    const url = `https://smartsubsv2.example/c/${encodeURIComponent(token)}/subsource/321/0/0.srt`
    const first = await handleRequest(new Request(url), { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv })
    const second = await handleRequest(new Request(url), { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv })
    assert.equal(first.status, 200)
    assert.match(await first.text(), /Hello/)
    assert.equal(first.headers.get('x-smartsubs-cache'), 'MISS')
    assert.equal(second.headers.get('x-smartsubs-cache'), 'HIT')
    assert.equal(calls, 1)
  } finally {
    global.fetch = originalFetch
  }
})

test('Part 5.2 Diagnose ignores a newer stale v1 404 probe and shows the valid v2 result', async () => {
  const { renderConfiguredDiagnosePage } = await import('../src/cloudflare-worker.mjs')
  const html = renderConfiguredDiagnosePage('config', [
    { ts: 200, event: 'subsource-probe', subsourceProbeVersion: 1, subsourceStatus: 'reachable', subsourceHttpStatus: 404 },
    { ts: 100, event: 'subsource-probe', subsourceProbeVersion: 2, subsourceStatus: 'connected', subsourceHttpStatus: 200 }
  ], { subsourceConfigured: true })
  assert.match(html, /Optional provider[\s\S]*?HTTP 200/)
})
