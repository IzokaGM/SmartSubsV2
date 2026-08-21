'use strict'

module.exports = {
  id: 'community.smartsubsv2',
  version: '1.0.0',
  name: 'SmartSubsV2',
  description: 'Smart Malay subtitles with OpenSubtitles v3 and Gemini BYOK translation',
  resources: [
    { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }
  ],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: true, configurationRequired: true }
}
