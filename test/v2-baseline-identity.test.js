'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const manifest = require('../src/manifest')
const { createConfiguredManifest } = require('../src/configured-manifest')

test('SmartSubsV2 has a unique addon identity from stable SmartSubs', () => {
  assert.equal(manifest.id, 'community.smartsubsv2')
  assert.equal(manifest.name, 'SmartSubsV2')
  assert.notEqual(manifest.id, 'community.smartsubs')
})

test('configured SmartSubsV2 manifest preserves V2 identity and subtitle resource', () => {
  const configured = createConfiguredManifest()

  assert.equal(configured.id, 'community.smartsubsv2')
  assert.equal(configured.name, 'SmartSubsV2')
  assert.equal(configured.behaviorHints.configurationRequired, false)

  const subtitles = configured.resources.find(
    resource => resource && resource.name === 'subtitles'
  )

  assert.ok(subtitles)
  assert.deepEqual(subtitles.types, ['movie', 'series'])
  assert.deepEqual(subtitles.idPrefixes, ['tt'])
})
