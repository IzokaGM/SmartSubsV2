'use strict'

function nowMs() {
  if (typeof process !== 'undefined' && process.hrtime && typeof process.hrtime.bigint === 'function') {
    return Number(process.hrtime.bigint()) / 1e6
  }
  return Date.now()
}

function roundMs(value) {
  return Math.max(0, Math.round(Number(value) || 0))
}

function logPerf(payload = {}) {
  try {
    console.log(JSON.stringify({ tag: 'SMARTSUBS_PERF', ...payload }))
  } catch {}
}

module.exports = { nowMs, roundMs, logPerf }
