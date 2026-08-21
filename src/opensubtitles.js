'use strict'

const UPSTREAM = 'https://opensubtitles-v3.strem.io'

function isSupportedRequest(args = {}) {
  return ['movie', 'series'].includes(args.type) && /^tt\d+(?::\d+:\d+)?$/.test(String(args.id || ''))
}

function serialiseExtra(extra = {}) {
  const pairs = []
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null || value === '') continue
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return pairs.join('&')
}

function upstreamUrl(args = {}) {
  const base = `${UPSTREAM}/subtitles/${encodeURIComponent(args.type)}/${encodeURIComponent(args.id)}`
  const extra = serialiseExtra(args.extra)
  return extra ? `${base}/${extra}.json` : `${base}.json`
}

async function fetchOpenSubtitles(args = {}, options = {}) {
  if (!isSupportedRequest(args)) return []
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(upstreamUrl(args), {
      headers: { accept: 'application/json', 'user-agent': 'SmartSubs/1.0.0' },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`OpenSubtitles v3 HTTP ${response.status}`)
    const data = await response.json()
    return Array.isArray(data && data.subtitles) ? data.subtitles : []
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { UPSTREAM, isSupportedRequest, serialiseExtra, upstreamUrl, fetchOpenSubtitles }
