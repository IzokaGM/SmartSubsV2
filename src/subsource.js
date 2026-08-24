'use strict'

const API_BASE = 'https://api.subsource.net/api/v1'
const DEFAULT_TIMEOUT_MS = 3500
const PROBE_VERSION = 2
const PROBE_QUERY = 'Toy Story'
const PROBE_URL = `${API_BASE}/movies/search?searchType=text&q=${encodeURIComponent(PROBE_QUERY)}`

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
  PROBE_VERSION,
  PROBE_QUERY,
  PROBE_URL,
  responseShape,
  subsourceStatus,
  rateLimitHeaderNames,
  probeSubsourceApi,
  validateSubsourceApiKey
}
