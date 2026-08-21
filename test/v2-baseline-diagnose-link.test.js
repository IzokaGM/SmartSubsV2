'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { renderConfigurePage } = require('../src/configure')

test('V2 configure result shows install and diagnose actions', () => {
  const html = renderConfigurePage({
    secretReady: true,
    model: 'gemini-3.5-flash-lite',
    manifestUrl: 'https://smartsubsv2.example/c/private/manifest.json',
    installUrl: 'stremio://smartsubsv2.example/c/private/manifest.json',
    diagnoseUrl: 'https://smartsubsv2.example/c/private/diagnose'
  })

  assert.match(html, /SmartSubsV2 is configured/)
  assert.match(html, /Install in Stremio/)
  assert.match(html, /Open Diagnose/)
  assert.match(html, /https:\/\/smartsubsv2\.example\/c\/private\/diagnose/)
})
