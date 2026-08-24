'use strict'

const crypto = require('node:crypto')
const config = require('./config')
const { nowMs, roundMs, logPerf } = require('./perf')
const { isSupportedRequest, fetchOpenSubtitles } = require('./opensubtitles')
const { getMalaySubtitles, toNativeMalay } = require('./languages')
const { selectBestEnglish, rankEnglishSubtitles, rankMalaySubtitles } = require('./selector')
const { createTranslationToken } = require('./token')
const { fetchSubsourceCandidates } = require('./subsource')

async function emitDiagnostic(options, payload) {
  if (typeof options.onDiagnostic !== 'function') return
  try {
    await options.onDiagnostic(payload)
  } catch {}
}

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

function sourceFilename(extra = {}) {
  const value = String(extra.filename || extra.fileName || extra.file_name || '').trim()
  if (!value) return ''
  return value.split(/[\\/]/).pop() || value
}

function diagnosticSubtitleId(subtitle, index = 0) {
  if (!subtitle || typeof subtitle !== 'object') return `index-${index}`
  const value = subtitle.id ?? subtitle.file_id ?? subtitle.fileId ?? subtitle.subtitle_id ?? subtitle.subtitleId
  return value == null || value === '' ? `index-${index}` : String(value)
}

function englishSelectionDiagnostics(upstream, selectedEnglish, extra = {}) {
  const ranked = rankEnglishSubtitles(upstream, extra)
  const top = ranked.slice(0, 5)
  const selectedEntry = ranked.find(item => item.subtitle === selectedEnglish) || null
  const rankedWinner = ranked[0]?.subtitle || null

  return {
    sourceFilenameProvided: Boolean(extra && (extra.filename || extra.fileName || extra.file_name)),
    sourceVideoHashProvided: Boolean(extra && extra.videoHash),
    sourceVideoSizeProvided: Boolean(extra && extra.videoSize),
    sourceFilename: sourceFilename(extra),
    requestExtraKeys: Object.keys(extra || {}).sort().slice(0, 8),
    englishCandidateCount: ranked.length,
    englishSelectedId: selectedEnglish ? diagnosticSubtitleId(selectedEnglish) : '',
    englishSelectedScore: selectedEntry ? selectedEntry.score : null,
    englishConfidence: selectedEntry?.confidence?.level || '',
    englishConfidenceReason: selectedEntry?.confidence?.reason || '',
    englishScoreUplift: selectedEntry?.confidence?.scoreUplift ?? null,
    englishSelectionStable: selectedEnglish === rankedWinner,
    englishTop: top.map((item, index) =>
      `${index + 1}:${diagnosticSubtitleId(item.subtitle, index)}:${item.score}`
    )
  }
}

function buildAutoSubtitle(englishSubtitle, options = {}) {
  const publicBaseUrl = options.publicBaseUrl ?? config.publicBaseUrl
  const tokenSecret = options.tokenSecret ?? config.tokenSecret
  if (!englishSubtitle || !publicBaseUrl || !tokenSecret) return null
  const token = createTranslationToken(englishSubtitle.url, tokenSecret, englishSubtitle.id)
  const shortId = crypto.createHash('sha1').update(englishSubtitle.url).digest('hex').slice(0, 12)
  return {
    id: `smartsubs-auto-${shortId}`,
    url: `${String(publicBaseUrl).replace(/\/+$/, '')}/translated/${token}.vtt`,
    lang: 'msa'
  }
}

function buildEnglishTracks(upstream, extra = {}, limit = 5) {
  const maxTracks = Math.max(1, Math.min(5, Number(limit) || 5))
  return rankEnglishSubtitles(dedupeSubtitles(upstream), extra)
    .slice(0, maxTracks)
    .map((item, index) => {
      const subtitle = item.subtitle
      return {
        id: `smartsubs-eng-${diagnosticSubtitleId(subtitle, index)}`,
        url: String(subtitle.url),
        lang: 'eng'
      }
    })
}

function seriesReleaseMatches(subtitle, id) {
  const match = String(id || '').match(/^tt\d+:(\d+):(\d+)$/)
  if (!match) return true
  const season = Number(match[1])
  const episode = Number(match[2])
  const text = [subtitle?.releaseName, ...(Array.isArray(subtitle?.releaseInfo) ? subtitle.releaseInfo : [])]
    .join(' ')
  const seasonEpisodeTokens = [
    ...text.matchAll(/\bs(\d{1,2})[ ._-]*e(\d{1,3})\b/gi),
    ...text.matchAll(/\b(\d{1,2})x(\d{1,3})\b/gi)
  ]
  if (!seasonEpisodeTokens.length) return false
  return seasonEpisodeTokens.some(token => Number(token[1]) === season && Number(token[2]) === episode)
}

function admitSubsourceCandidates(candidates, args = {}) {
  const accepted = []
  const rejected = []
  for (const subtitle of candidates || []) {
    if (!subtitle || subtitle.provider !== 'subsource') {
      accepted.push(subtitle)
      continue
    }
    const ranked = subtitle.lang === 'msa'
      ? rankMalaySubtitles([subtitle], args.extra || {})
      : rankEnglishSubtitles([subtitle], args.extra || {})
    const confidence = ranked[0]?.confidence?.level || 'WEAK'
    const episodeMatches = args.type !== 'series' || seriesReleaseMatches(subtitle, args.id)
    if (confidence === 'STRONG' && episodeMatches) accepted.push(subtitle)
    else rejected.push({ subtitle, confidence, episodeMatches })
  }
  return { accepted, rejected }
}

async function handleSubtitles(args, options = {}) {
  const startedAt = nowMs()
  const requestId = crypto.randomUUID()
  if (!isSupportedRequest(args)) {
    await emitDiagnostic(options, {
      event: 'subtitle-result',
      result: 'unsupported-request',
      type: args && args.type,
      id: args && args.id,
      subtitleCount: 0
    })
    return { subtitles: [], cacheMaxAge: 60 }
  }

  try {
    const upstreamStartedAt = nowMs()
    let openSubtitles = []
    let openSubtitlesStatus = 'connected'
    try {
      openSubtitles = await fetchOpenSubtitles(args, options)
    } catch (error) {
      openSubtitlesStatus = 'fallback'
      await emitDiagnostic(options, {
        event: 'opensubtitles-provider',
        status: 'fallback',
        error: String(error?.message || error || '').slice(0, 120)
      })
    }
    const upstreamMs = roundMs(nowMs() - upstreamStartedAt)
    const initialMalay = rankMalaySubtitles(
      dedupeSubtitles(getMalaySubtitles(openSubtitles)),
      args.extra || {}
    )
    const initialEnglish = rankEnglishSubtitles(openSubtitles, args.extra || {})
    const subsourceConfigured = Boolean(options.subsourceApiKey)
    const subsourceTriggered = subsourceConfigured && (
      initialMalay[0]?.confidence?.level !== 'STRONG' ||
      initialEnglish[0]?.confidence?.level !== 'STRONG'
    )
    let subsourceCandidates = []
    let subsourceStatus = subsourceConfigured ? 'not-needed' : 'not-configured'
    let subsourceLatencyMs = 0
    let subsourceCache = ''
    if (subsourceTriggered) {
      try {
        const fetchCandidates = options.fetchSubsourceCandidatesFn || fetchSubsourceCandidates
        const fusion = await fetchCandidates(args, options.subsourceApiKey, {
          fetchImpl: options.subsourceFetchImpl,
          timeoutMs: options.subsourceTimeoutMs,
          kv: options.subsourceKv,
          publicBaseUrl: options.publicBaseUrl
        })
        subsourceCandidates = Array.isArray(fusion?.candidates) ? fusion.candidates : []
        subsourceLatencyMs = Number(fusion?.latencyMs || 0)
        subsourceCache = String(fusion?.cache || '')
        subsourceStatus = fusion?.partial ? 'partial' : 'connected'
      } catch (error) {
        subsourceStatus = /429/.test(String(error?.message || ''))
          ? 'quota-limited'
          : /401|403/.test(String(error?.message || ''))
            ? 'key-rejected'
            : /abort|timeout/i.test(String(error?.message || error || ''))
              ? 'timeout'
              : 'fallback'
        await emitDiagnostic(options, {
          event: 'subsource-fusion',
          status: subsourceStatus,
          fallback: 'opensubtitles',
          error: String(error?.message || error || '').slice(0, 120)
        })
      }
    }
    const admittedSubsource = admitSubsourceCandidates(subsourceCandidates, args)
    const safeSubsourceCandidates = admittedSubsource.accepted
    const upstream = dedupeSubtitles([...openSubtitles, ...safeSubsourceCandidates])
    const providerDiagnostic = {
      openSubtitlesCount: openSubtitles.length,
      openSubtitlesStatus,
      subsourceConfigured,
      subsourceTriggered,
      subsourceStatus,
      subsourceCandidateCount: subsourceCandidates.length,
      subsourceAcceptedCount: safeSubsourceCandidates.length,
      subsourceRejectedCount: admittedSubsource.rejected.length,
      subsourceLatencyMs,
      subsourceCache
    }
    if (subsourceTriggered && subsourceStatus !== 'fallback') {
      await emitDiagnostic(options, {
        event: 'subsource-fusion',
        ...providerDiagnostic
      })
    }
    const rankedMalay = rankMalaySubtitles(
      dedupeSubtitles(getMalaySubtitles(upstream)),
      args.extra || {}
    )
    const malay = rankedMalay.map(item => item.subtitle)
    const malaySelectionDiagnostic = {
      malayCandidateCount: rankedMalay.length,
      malaySelectedId: rankedMalay[0] ? diagnosticSubtitleId(rankedMalay[0].subtitle) : '',
      malaySelectedScore: rankedMalay[0] ? rankedMalay[0].score : null,
      nativeConfidence: rankedMalay[0]?.confidence?.level || 'NONE',
      nativeConfidenceReason: rankedMalay[0]?.confidence?.reason || 'no-native-malay',
      nativeScoreUplift: rankedMalay[0]?.confidence?.scoreUplift ?? null,
      malayTop: rankedMalay.slice(0, 5).map((item, index) =>
        `${index + 1}:${diagnosticSubtitleId(item.subtitle, index)}:${item.score}`
      )
    }
    const english = selectBestEnglish(upstream, args.extra || {})
    const selectionDiagnostic = englishSelectionDiagnostics(
      upstream,
      english,
      args.extra || {}
    )

    const apiKey = options.apiKey || ''
    const auto = english && apiKey ? buildAutoSubtitle(english, options) : null
    const englishTracks = options.includeEnglishTracks
      ? buildEnglishTracks(upstream, args.extra || {}, options.englishTrackLimit)
      : []

    if (malay.length) {
      const nativeSubtitles = malay.slice(0, 5).map(toNativeMalay)
      const nativeConfidence = malaySelectionDiagnostic.nativeConfidence
      const nativeStrong = nativeConfidence === 'STRONG'
      const autoFallbackOffered = Boolean(auto) && !nativeStrong
      const nativeDecision = nativeStrong
        ? 'native-only-strong'
        : autoFallbackOffered
          ? 'dual-fallback'
          : 'native-only-auto-unavailable'
      const autoPrefetch = false
      const autoPrefetchReason = nativeStrong
        ? 'native-strong-no-auto-needed'
        : autoFallbackOffered
          ? 'weak-native-wait-for-user-selection'
          : 'auto-unavailable'
      const malayOptions = autoFallbackOffered
        ? [...nativeSubtitles, auto]
        : nativeSubtitles
      const subtitles = [...malayOptions, ...englishTracks]
      const resultName = autoFallbackOffered
        ? 'native-malay-with-auto-fallback'
        : 'native-malay'

      logPerf({
        requestId,
        milestone: 'V2-P3',
        type: args.type,
        id: args.id,
        upstreamMs,
        upstreamCount: upstream.length,
        ...providerDiagnostic,
        malayCount: malay.length,
        ...malaySelectionDiagnostic,
        englishFound: Boolean(english),
        ...selectionDiagnostic,
        nativeDecision,
        autoFallbackOffered,
        autoPrefetch,
        autoPrefetchReason,
        geminiPrefetchAvoided: true,
        englishTrackCount: englishTracks.length,
        result: resultName,
        totalMs: roundMs(nowMs() - startedAt)
      })

      await emitDiagnostic(options, {
        event: 'subtitle-result',
        type: args.type,
        id: args.id,
        result: resultName,
        upstreamCount: upstream.length,
        ...providerDiagnostic,
        malayCount: malay.length,
        ...malaySelectionDiagnostic,
        englishFound: Boolean(english),
        ...selectionDiagnostic,
        byokConfigured: Boolean(apiKey),
        autoReady: Boolean(autoFallbackOffered),
        nativeDecision,
        autoFallbackOffered,
        autoPrefetch,
        autoPrefetchReason,
        geminiPrefetchAvoided: true,
        englishTrackCount: englishTracks.length,
        subtitleCount: subtitles.length,
        languages: subtitles.map(item => item.lang)
      })

      return {
        subtitles,
        autoPrefetch,
        autoPrefetchReason,
        cacheMaxAge: 120,
        staleRevalidate: 60,
        staleError: 600
      }
    }

    const subtitles = [...(auto ? [auto] : []), ...englishTracks]
    const resultName = auto ? 'auto-malay-ready' : english ? 'byok-not-configured' : 'no-english'
    logPerf({
      requestId,
      milestone: auto ? 'M6' : 'M4',
      type: args.type,
      id: args.id,
      upstreamMs,
      upstreamCount: upstream.length,
      ...providerDiagnostic,
      malayCount: 0,
      ...malaySelectionDiagnostic,
      englishFound: Boolean(english),
        ...selectionDiagnostic,
      autoReady: Boolean(auto),
      byokConfigured: Boolean(apiKey),
      publicBaseConfigured: Boolean(options.publicBaseUrl ?? config.publicBaseUrl),
      nativeDecision: 'no-native-malay',
      autoFallbackOffered: false,
      autoPrefetch: Boolean(auto),
      autoPrefetchReason: auto ? 'no-native-malay-aggressive-prefetch' : 'auto-unavailable',
      geminiPrefetchAvoided: false,
      englishTrackCount: englishTracks.length,
      result: resultName,
      totalMs: roundMs(nowMs() - startedAt)
    })
    await emitDiagnostic(options, {
      event: 'subtitle-result',
      type: args.type,
      id: args.id,
      result: resultName,
      upstreamCount: upstream.length,
      ...providerDiagnostic,
      malayCount: 0,
      ...malaySelectionDiagnostic,
      englishFound: Boolean(english),
        ...selectionDiagnostic,
      byokConfigured: Boolean(apiKey),
      autoReady: Boolean(auto),
      nativeDecision: 'no-native-malay',
      autoFallbackOffered: false,
      autoPrefetch: Boolean(auto),
      autoPrefetchReason: auto ? 'no-native-malay-aggressive-prefetch' : 'auto-unavailable',
      geminiPrefetchAvoided: false,
      englishTrackCount: englishTracks.length,
      subtitleCount: subtitles.length,
      languages: subtitles.map(item => item.lang)
    })
    return {
      subtitles,
      autoPrefetch: Boolean(auto),
      autoPrefetchReason: auto ? 'no-native-malay-aggressive-prefetch' : 'auto-unavailable',
      cacheMaxAge: auto ? 120 : 60,
      staleRevalidate: 60,
      staleError: 600
    }
  } catch (error) {
    const message = error && error.message || String(error)
    console.error(JSON.stringify({
      tag: 'SMARTSUBS_ERROR',
      requestId,
      type: args.type,
      id: args.id,
      message
    }))
    await emitDiagnostic(options, {
      event: 'subtitle-result',
      type: args.type,
      id: args.id,
      result: 'error',
      subtitleCount: 0,
      error: message.slice(0, 160)
    })
    return { subtitles: [], cacheMaxAge: 15, staleError: 60 }
  }
}

module.exports = {
  dedupeSubtitles,
  buildAutoSubtitle,
  buildEnglishTracks,
  seriesReleaseMatches,
  admitSubsourceCandidates,
  handleSubtitles,
  englishSelectionDiagnostics
}
