'use strict'

const crypto = require('node:crypto')
const config = require('./config')
const { nowMs, roundMs, logPerf } = require('./perf')
const { isSupportedRequest, fetchOpenSubtitles } = require('./opensubtitles')
const { getMalaySubtitles, getEnglishSubtitles, toNativeMalay } = require('./languages')
const { createTranslationToken } = require('./token')

const MAX_SUBTITLE_TRACKS = 5

async function emitDiagnostic(options, payload) {
  if (typeof options.onDiagnostic !== 'function') return
  try { await options.onDiagnostic(payload) } catch {}
}

// Preserve upstream ordering and ignore unusable/duplicate URLs.
function dedupeSubtitles(subtitles) {
  const seen = new Set()
  const output = []
  for (const subtitle of subtitles || []) {
    if (!subtitle || !subtitle.url) continue
    const key = `${String(subtitle.lang || '').trim().toLowerCase()}|${String(subtitle.url).trim()}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(subtitle)
  }
  return output
}

function diagnosticSubtitleId(subtitle, index = 0) {
  if (!subtitle || typeof subtitle !== 'object') return `index-${index}`
  const value = subtitle.id ?? subtitle.file_id ?? subtitle.fileId ?? subtitle.subtitle_id ?? subtitle.subtitleId
  return value == null || value === '' ? `index-${index}` : String(value)
}

function englishSelectionDiagnostics(upstream, selectedEnglish) {
  const candidates = dedupeSubtitles(getEnglishSubtitles(upstream))
  return {
    englishCandidateCount: candidates.length,
    englishSelectedId: selectedEnglish ? diagnosticSubtitleId(selectedEnglish) : '',
    englishSourceIds: candidates.slice(0, MAX_SUBTITLE_TRACKS).map((subtitle, index) => diagnosticSubtitleId(subtitle, index))
  }
}

function buildAutoSubtitle(englishSubtitle, options = {}) {
  const publicBaseUrl = options.publicBaseUrl ?? config.publicBaseUrl
  const tokenSecret = options.tokenSecret ?? config.tokenSecret
  if (!englishSubtitle || !publicBaseUrl || !tokenSecret) return null
  const token = createTranslationToken(englishSubtitle.url, tokenSecret, englishSubtitle.id, options.media)
  const upstreamId = englishSubtitle.id ?? englishSubtitle.file_id ?? englishSubtitle.fileId
    ?? englishSubtitle.subtitle_id ?? englishSubtitle.subtitleId
  const sourceId = upstreamId == null || String(upstreamId).trim() === ''
    ? crypto.createHash('sha1').update(englishSubtitle.url).digest('hex').slice(0, 12)
    : String(upstreamId).trim()
  // Visible track ID identifies the exact upstream subtitle source. Delivery URL/token stay unchanged.
  return {
    id: `gemini-ai-${sourceId}`,
    url: `${String(publicBaseUrl).replace(/\/+$/, '')}/translated/${token}.vtt`,
    lang: 'msa'
  }
}

function buildAutoSubtitles(englishSubtitles, options = {}) {
  return dedupeSubtitles(englishSubtitles)
    .slice(0, MAX_SUBTITLE_TRACKS)
    .map(subtitle => buildAutoSubtitle(subtitle, options))
    .filter(Boolean)
}

function buildEnglishTracks(upstream) {
  return dedupeSubtitles(getEnglishSubtitles(upstream))
    .slice(0, MAX_SUBTITLE_TRACKS)
    .map((subtitle, index) => ({
      id: `opensubtitles-eng-${diagnosticSubtitleId(subtitle, index)}`,
      url: String(subtitle.url),
      lang: 'eng'
    }))
}

async function handleSubtitles(args, options = {}) {
  const startedAt = nowMs()
  const requestId = crypto.randomUUID()
  if (!isSupportedRequest(args)) {
    await emitDiagnostic(options, {
      event: 'subtitle-result', result: 'unsupported-request',
      type: args && args.type, id: args && args.id, subtitleCount: 0
    })
    return { subtitles: [], cacheMaxAge: 60 }
  }

  try {
    const upstreamStartedAt = nowMs()
    const upstream = await fetchOpenSubtitles(args, options)
    const upstreamMs = roundMs(nowMs() - upstreamStartedAt)
    const malay = dedupeSubtitles(getMalaySubtitles(upstream))
      .slice(0, MAX_SUBTITLE_TRACKS).map(toNativeMalay)
    const englishCandidates = dedupeSubtitles(getEnglishSubtitles(upstream))
    const english = englishCandidates[0] || null
    const apiKey = options.apiKey || ''
    // V2 multi-candidate mode: up to five eligible English sources get Malay AI
    // translation URL. Creating these signed URLs does not fetch or translate anything.
    // Translation starts only when the player requests the selected /translated/*.vtt URL.
    const aiTracks = apiKey ? buildAutoSubtitles(englishCandidates, options) : []
    const englishTracks = options.includeEnglishTracks
      ? buildEnglishTracks(upstream) : []

    // Automatic prefetch is deliberately disabled in V2. With several AI candidates,
    // background translation would multiply Gemini usage before the user picks a source.
    const autoPrefetch = false
    const autoPrefetchReason = aiTracks.length ? 'on-demand-candidate-selection' : 'ai-unavailable'
    const subtitles = [...malay, ...aiTracks, ...englishTracks]
    const resultName = malay.length
      ? (aiTracks.length ? 'native-malay-with-on-demand-ai' : 'native-malay')
      : aiTracks.length ? 'on-demand-ai-ready' : english ? 'byok-not-configured' : 'no-english'
    // No English source is selected during subtitle discovery anymore. Selection happens
    // later, when the player requests one candidate's translated URL.
    const selectionDiagnostic = englishSelectionDiagnostics(upstream, null)
    const info = {
      requestId, type: args.type, id: args.id, upstreamMs,
      upstreamCount: upstream.length, malayCount: malay.length,
      englishFound: Boolean(english), ...selectionDiagnostic,
      byokConfigured: Boolean(apiKey), autoReady: aiTracks.length > 0,
      aiCandidateCount: aiTracks.length,
      autoPrefetch, autoPrefetchReason,
      englishTrackCount: englishTracks.length, subtitleCount: subtitles.length,
      languages: subtitles.map(item => item.lang), result: resultName
    }
    logPerf({ ...info, milestone: 'SMARTSUBS-SIMPLE', totalMs: roundMs(nowMs() - startedAt) })
    await emitDiagnostic(options, { event: 'subtitle-result', ...info })
    return { subtitles, autoPrefetch, autoPrefetchReason,
      cacheMaxAge: aiTracks.length || malay.length ? 120 : 60, staleRevalidate: 60, staleError: 600 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logPerf({ requestId, milestone: 'SMARTSUBS-SIMPLE', type: args.type, id: args.id, error: message })
    await emitDiagnostic(options, { event: 'subtitle-result', type: args.type, id: args.id,
      result: 'error', subtitleCount: 0, error: message.slice(0, 160) })
    return { subtitles: [], cacheMaxAge: 15, staleError: 60 }
  }
}

module.exports = { dedupeSubtitles, buildAutoSubtitle, buildAutoSubtitles, buildEnglishTracks,
  handleSubtitles, englishSelectionDiagnostics }
