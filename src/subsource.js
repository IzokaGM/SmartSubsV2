'use strict'

const crypto = require('node:crypto')

const API_BASE = 'https://api.subsource.net/api/v1'
const DEFAULT_TIMEOUT_MS = 3500
const FUSION_TIMEOUT_MS = 2500
const PROBE_VERSION = 2
const PROBE_QUERY = 'Toy Story'
const PROBE_URL = `${API_BASE}/movies/search?searchType=text&q=${encodeURIComponent(PROBE_QUERY)}`
const inFlightFusion = new Map()

function safeHeader(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return ''
  return String(response.headers.get(name) || '').slice(0, 80)
}

function rateLimitHeaderNames(response) {
  if (!response || !response.headers || typeof response.headers.entries !== 'function') return []
  return [...response.headers.entries()]
    .map(([name]) => String(name).toLowerCase())
    .filter(name => name.includes('ratelimit') || name.includes('rate-limit'))
    .sort()
    .slice(0, 24)
}

function responseShape(value) {
  if (Array.isArray(value)) {
    const first = value.find(item => item && typeof item === 'object' && !Array.isArray(item))
    return {
      rootType: 'array',
      topKeys: [],
      itemKeys: first ? Object.keys(first).sort().slice(0, 24) : []
    }
  }
  if (value && typeof value === 'object') {
    const topKeys = Object.keys(value).sort().slice(0, 24)
    let itemKeys = []
    for (const key of topKeys) {
      const candidate = value[key]
      if (!Array.isArray(candidate)) continue
      const first = candidate.find(item => item && typeof item === 'object' && !Array.isArray(item))
      if (first) {
        itemKeys = Object.keys(first).sort().slice(0, 24)
        break
      }
    }
    return { rootType: 'object', topKeys, itemKeys }
  }
  return { rootType: typeof value, topKeys: [], itemKeys: [] }
}

function subsourceStatus(httpStatus) {
  if (httpStatus >= 200 && httpStatus < 300) return 'connected'
  if (httpStatus === 401 || httpStatus === 403) return 'key-rejected'
  if (httpStatus === 429) return 'quota-limited'
  if (httpStatus >= 500) return 'provider-unavailable'
  return 'reachable'
}

function apiHeaders(apiKey) {
  return {
    accept: 'application/json',
    'x-api-key': String(apiKey || '').trim()
  }
}

async function fetchWithTimeout(url, apiKey, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Math.max(250, Math.min(10000, Number(options.timeoutMs || FUSION_TIMEOUT_MS)))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: apiHeaders(apiKey),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

function responseData(value) {
  if (Array.isArray(value)) return value
  return Array.isArray(value && value.data) ? value.data : []
}

async function readJsonCache(kv, key) {
  if (!kv || typeof kv.get !== 'function') return null
  try {
    const value = await kv.get(key, { type: 'json' })
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return null
  }
}

async function writeJsonCache(kv, key, value, expirationTtl) {
  if (!kv || typeof kv.put !== 'function') return
  await kv.put(key, JSON.stringify(value), { expirationTtl }).catch(() => {})
}

function keyFingerprint(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16)
}

function circuitKey(apiKey) {
  return `subsource:circuit:v1:${keyFingerprint(apiKey)}`
}

async function assertCircuitOpen(kv, apiKey) {
  const state = await readJsonCache(kv, circuitKey(apiKey))
  if (state && Number(state.until || 0) > Date.now()) {
    throw new Error(`SubSource circuit open HTTP ${Number(state.status || 429)}`)
  }
}

async function throwApiError(response, apiKey, options, stage) {
  const status = Number(response.status || 0)
  if (status === 429 && options.kv) {
    const rawReset = safeHeader(response, 'x-ratelimit-reset')
    const parsedReset = Date.parse(rawReset)
    const until = Number.isFinite(parsedReset) && parsedReset > Date.now()
      ? parsedReset
      : Date.now() + 60 * 1000
    const ttl = Math.max(60, Math.min(3600, Math.ceil((until - Date.now()) / 1000)))
    await writeJsonCache(options.kv, circuitKey(apiKey), { status, until }, ttl)
  }
  throw new Error(`SubSource ${stage} HTTP ${status}`)
}

function parseMediaId(args = {}) {
  const match = String(args.id || '').match(/^(tt\d+)(?::(\d+):(\d+))?$/)
  if (!match) return null
  return {
    imdbId: match[1],
    season: match[2] ? Number(match[2]) : null,
    episode: match[3] ? Number(match[3]) : null
  }
}

function selectMovie(items, media, type) {
  const exact = items.filter(item => String(item && item.imdbId || '').toLowerCase() === media.imdbId.toLowerCase())
  const seasonExact = media.season == null
    ? exact
    : exact.filter(item => Number(item && item.season) === media.season)
  if (media.season != null && !seasonExact.length) return null
  const pool = seasonExact
  return pool.find(item => !item.type || String(item.type).toLowerCase() === String(type || '').toLowerCase()) || pool[0] || null
}

async function findSubsourceMovie(args, apiKey, options = {}) {
  const media = parseMediaId(args)
  if (!media) return null
  const cacheKey = `subsource:movie:v1:${media.imdbId}:${media.season || 0}`
  const cached = await readJsonCache(options.kv, cacheKey)
  if (cached && cached.movieId) return { ...cached, cache: 'HIT' }

  const params = new URLSearchParams({ searchType: 'imdb', imdb: media.imdbId })
  if (media.season != null) params.set('season', String(media.season))
  const response = await fetchWithTimeout(`${API_BASE}/movies/search?${params}`, apiKey, options)
  if (!response.ok) await throwApiError(response, apiKey, options, 'movie search')
  const movie = selectMovie(responseData(await response.json()), media, args.type)
  if (!movie || !movie.movieId) return null
  const result = {
    movieId: Number(movie.movieId),
    imdbId: String(movie.imdbId || media.imdbId),
    title: String(movie.title || ''),
    season: movie.season == null ? media.season : Number(movie.season),
    subtitleCount: Number(movie.subtitleCount || 0)
  }
  await writeJsonCache(options.kv, cacheKey, result, 30 * 24 * 60 * 60)
  return { ...result, cache: 'MISS' }
}

function subsourceLanguage(value) {
  const language = String(value || '').trim().toLowerCase()
  if (['malay', 'malaysian', 'bahasa melayu', 'ms', 'msa', 'may'].includes(language)) return 'msa'
  if (['english', 'en', 'eng'].includes(language)) return 'eng'
  return language
}

function normaliseSubsourceSubtitle(item, baseUrl, season = 0, episode = 0) {
  const subtitleId = Number(item && item.subtitleId)
  if (!Number.isInteger(subtitleId) || subtitleId <= 0) return null
  const releases = Array.isArray(item.releaseInfo) ? item.releaseInfo.map(String).filter(Boolean).slice(0, 20) : []
  return {
    id: `subsource-${subtitleId}`,
    subtitleId,
    provider: 'subsource',
    lang: subsourceLanguage(item.language),
    language: String(item.language || ''),
    url: `${String(baseUrl || '').replace(/\/+$/, '')}/subsource/${subtitleId}/${Math.max(0, Number(season || 0))}/${Math.max(0, Number(episode || 0))}.srt`,
    releaseInfo: releases,
    releaseName: releases.join(' '),
    commentary: String(item.commentary || ''),
    files: Number(item.files || 0),
    archiveSize: Number(item.size || 0),
    hearingImpaired: Boolean(item.hearingImpaired),
    foreignParts: Boolean(item.foreignParts),
    framerate: String(item.framerate || ''),
    productionType: String(item.productionType || ''),
    releaseType: String(item.releaseType || ''),
    downloads: Number(item.downloads || 0),
    comments: Number(item.comments || 0),
    rating: item.rating && typeof item.rating === 'object'
      ? {
          good: Number(item.rating.good || 0),
          bad: Number(item.rating.bad || 0),
          total: Number(item.rating.total || 0)
        }
      : null,
    uploaderId: Number(item.uploaderId || 0),
    createdAt: String(item.createdAt || '')
  }
}

async function fetchSubtitleLanguage(movieId, language, apiKey, options = {}) {
  const cacheKey = `subsource:list:v1:${movieId}:${language}`
  const cached = await readJsonCache(options.kv, cacheKey)
  if (Array.isArray(cached)) return { items: cached, cache: 'HIT' }
  const params = new URLSearchParams({
    movieId: String(movieId),
    language,
    limit: '30',
    sort: 'popular'
  })
  const response = await fetchWithTimeout(`${API_BASE}/subtitles?${params}`, apiKey, options)
  if (!response.ok) await throwApiError(response, apiKey, options, 'subtitle search')
  const items = responseData(await response.json()).slice(0, 30)
  await writeJsonCache(options.kv, cacheKey, items, 6 * 60 * 60)
  return { items, cache: 'MISS' }
}

async function fetchSubsourceCandidatesCore(args, apiKey, options = {}) {
  const startedAt = Date.now()
  await assertCircuitOpen(options.kv, apiKey)
  const movie = await findSubsourceMovie(args, apiKey, options)
  if (!movie) return { candidates: [], movie: null, latencyMs: Date.now() - startedAt, cache: 'MISS' }
  const settled = await Promise.allSettled([
    fetchSubtitleLanguage(movie.movieId, 'malay', apiKey, options),
    fetchSubtitleLanguage(movie.movieId, 'english', apiKey, options)
  ])
  const successful = settled.filter(result => result.status === 'fulfilled').map(result => result.value)
  if (!successful.length) {
    const reason = settled.find(result => result.status === 'rejected')
    throw reason ? reason.reason : new Error('SubSource subtitle search failed')
  }
  const candidates = successful
    .flatMap(result => result.items)
    .map(item => {
      const media = parseMediaId(args)
      return normaliseSubsourceSubtitle(
        item,
        options.publicBaseUrl,
        media?.season || 0,
        media?.episode || 0
      )
    })
    .filter(item => item && ['msa', 'eng'].includes(item.lang) && item.url)
  return {
    candidates,
    movie,
    latencyMs: Date.now() - startedAt,
    cache: movie.cache === 'HIT' && successful.every(result => result.cache === 'HIT') ? 'HIT' : 'MISS',
    partial: successful.length !== settled.length
  }
}

async function fetchSubsourceCandidates(args, apiKey, options = {}) {
  const media = parseMediaId(args)
  const requestKey = `${keyFingerprint(apiKey)}:${media?.imdbId || ''}:${media?.season || 0}:${media?.episode || 0}`
  if (inFlightFusion.has(requestKey)) return inFlightFusion.get(requestKey)
  const work = fetchSubsourceCandidatesCore(args, apiKey, options)
  inFlightFusion.set(requestKey, work)
  try {
    return await work
  } finally {
    if (inFlightFusion.get(requestKey) === work) inFlightFusion.delete(requestKey)
  }
}

async function downloadSubsourceArchive(subtitleId, apiKey, options = {}) {
  const id = Number(subtitleId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid SubSource subtitle ID')
  const response = await fetchWithTimeout(`${API_BASE}/subtitles/${id}/download`, apiKey, {
    ...options,
    timeoutMs: options.timeoutMs || 10000
  })
  if (!response.ok) await throwApiError(response, apiKey, options, 'download')
  return new Uint8Array(await response.arrayBuffer())
}

async function probeSubsourceApi(apiKey, options = {}) {
  const key = String(apiKey || '').trim()
  if (!key) return { configured: false, status: 'not-configured' }
  if (key.length < 8) throw new Error('SubSource API key looks invalid')

  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Math.max(250, Math.min(10000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const response = await fetchImpl(PROBE_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-api-key': key
      },
      signal: controller.signal
    })
    const contentType = safeHeader(response, 'content-type')
    let shape = { rootType: '', topKeys: [], itemKeys: [] }
    if (/application\/json/i.test(contentType) && typeof response.json === 'function') {
      try {
        shape = responseShape(await response.json())
      } catch {}
    }

    return {
      configured: true,
      status: subsourceStatus(response.status),
      httpStatus: Number(response.status || 0),
      latencyMs: Date.now() - startedAt,
      limit: safeHeader(response, 'x-ratelimit-limit'),
      remaining: safeHeader(response, 'x-ratelimit-remaining'),
      limitMinute: safeHeader(response, 'x-ratelimit-limit-minute'),
      remainingMinute: safeHeader(response, 'x-ratelimit-remaining-minute'),
      limitHour: safeHeader(response, 'x-ratelimit-limit-hour'),
      remainingHour: safeHeader(response, 'x-ratelimit-remaining-hour'),
      limitDay: safeHeader(response, 'x-ratelimit-limit-day'),
      remainingDay: safeHeader(response, 'x-ratelimit-remaining-day'),
      reset: safeHeader(response, 'x-ratelimit-reset'),
      rateHeaderNames: rateLimitHeaderNames(response),
      responseRootType: shape.rootType,
      responseTopKeys: shape.topKeys,
      responseItemKeys: shape.itemKeys
    }
  } catch (error) {
    const timedOut = error && (error.name === 'AbortError' || /abort|timeout/i.test(String(error.message || '')))
    return {
      configured: true,
      status: timedOut ? 'timeout' : 'provider-unavailable',
      httpStatus: 0,
      latencyMs: Date.now() - startedAt
    }
  } finally {
    clearTimeout(timer)
  }
}

async function validateSubsourceApiKey(apiKey, options = {}) {
  const result = await probeSubsourceApi(apiKey, options)
  if (!result.configured) return result
  if (result.status === 'key-rejected') {
    throw new Error(`SubSource API key rejected (HTTP ${result.httpStatus})`)
  }
  return result
}

module.exports = {
  API_BASE,
  DEFAULT_TIMEOUT_MS,
  FUSION_TIMEOUT_MS,
  PROBE_VERSION,
  PROBE_QUERY,
  PROBE_URL,
  responseShape,
  subsourceStatus,
  parseMediaId,
  selectMovie,
  subsourceLanguage,
  normaliseSubsourceSubtitle,
  findSubsourceMovie,
  fetchSubsourceCandidates,
  downloadSubsourceArchive,
  rateLimitHeaderNames,
  probeSubsourceApi,
  validateSubsourceApiKey
}
