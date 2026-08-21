'use strict'

const MALAY = new Set(['msa', 'may', 'ms', 'malay', 'bahasa melayu'])
const ENGLISH = new Set(['eng', 'en', 'english'])

function langOf(item) {
  return String(item && (item.lang || item.language || item.language_code) || '').trim().toLowerCase()
}

function getMalaySubtitles(subtitles = []) {
  return (Array.isArray(subtitles) ? subtitles : []).filter(item => MALAY.has(langOf(item)))
}

function getEnglishSubtitles(subtitles = []) {
  return (Array.isArray(subtitles) ? subtitles : []).filter(item => ENGLISH.has(langOf(item)))
}

function toNativeMalay(item = {}) {
  return { ...item, lang: 'msa' }
}

module.exports = { langOf, getMalaySubtitles, getEnglishSubtitles, toNativeMalay }
