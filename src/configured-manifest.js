'use strict'

const manifest = require('./manifest')

function createConfiguredManifest() {
  return {
    ...manifest,
    behaviorHints: {
      ...(manifest.behaviorHints || {}),
      configurable: true,
      configurationRequired: false
    }
  }
}

module.exports = { createConfiguredManifest }
