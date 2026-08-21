'use strict'

const crypto = require('node:crypto')
const config = require('./config')
const { nowMs, roundMs, logPerf } = require('./perf')
const { isSupportedRequest, fetchOpenSubtitles } = require('./opensubtitles')
const { getMalaySubtitles, toNativeMalay } = require('./languages')
const { selectBestEnglish, rankEnglishSubtitles, rankMalaySubtitles } = require('./selector')
const { createTranslationToken } = require('./token')

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
    const upstream = await fetchOpenSubtitles(args, options)
    const upstreamMs = roundMs(nowMs() - upstreamStartedAt)
    const rankedMalay = rankMalaySubtitles(
      dedupeSubtitles(getMalaySubtitles(upstream)),
      args.extra || {}
    )
    const malay = rankedMalay.map(item => item.subtitle)
    const malaySelectionDiagnostic = {
      malayCandidateCount: rankedMalay.length,
      malaySelectedId: rankedMalay[0] ? diagnosticSubtitleId(rankedMalay[0].subtitle) : '',
      malaySelectedScore: rankedMalay[0] ? rankedMalay[0].score : null,
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

    if (malay.length) {
      const subtitles = malay.slice(0, 5).map(toNativeMalay)
      logPerf({
        requestId,
        milestone: 'M3',
        type: args.type,
        id: args.id,
        upstreamMs,
        upstreamCount: upstream.length,
        malayCount: malay.length,
        ...malaySelectionDiagnostic,
        englishFound: Boolean(english),
        ...selectionDiagnostic,
        result: 'native-malay',
        totalMs: roundMs(nowMs() - startedAt)
      })
      await emitDiagnostic(options, {
        event: 'subtitle-result',
        type: args.type,
        id: args.id,
        result: 'native-malay',
        upstreamCount: upstream.length,
        malayCount: malay.length,
        ...malaySelectionDiagnostic,
        englishFound: Boolean(english),
        ...selectionDiagnostic,
        byokConfigured: Boolean(options.apiKey),
        autoReady: false,
        subtitleCount: subtitles.length,
        languages: subtitles.map(item => item.lang)
      })
      return { subtitles, cacheMaxAge: 300, staleRevalidate: 120, staleError: 3600 }
    }

    const apiKey = options.apiKey || ''
    const auto = english && apiKey ? buildAutoSubtitle(english, options) : null
    const resultName = auto ? 'auto-malay-ready' : english ? 'byok-not-configured' : 'no-english'
    logPerf({
      requestId,
      milestone: auto ? 'M6' : 'M4',
      type: args.type,
      id: args.id,
      upstreamMs,
      upstreamCount: upstream.length,
      malayCount: 0,
      ...malaySelectionDiagnostic,
      englishFound: Boolean(english),
        ...selectionDiagnostic,
      autoReady: Boolean(auto),
      byokConfigured: Boolean(apiKey),
      publicBaseConfigured: Boolean(options.publicBaseUrl ?? config.publicBaseUrl),
      result: resultName,
      totalMs: roundMs(nowMs() - startedAt)
    })
    await emitDiagnostic(options, {
      event: 'subtitle-result',
      type: args.type,
      id: args.id,
      result: resultName,
      upstreamCount: upstream.length,
      malayCount: 0,
      ...malaySelectionDiagnostic,
      englishFound: Boolean(english),
        ...selectionDiagnostic,
      byokConfigured: Boolean(apiKey),
      autoReady: Boolean(auto),
      subtitleCount: auto ? 1 : 0,
      languages: auto ? [auto.lang] : []
    })
    return {
      subtitles: auto ? [auto] : [],
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

module.exports = { dedupeSubtitles, buildAutoSubtitle, handleSubtitles, englishSelectionDiagnostics }
