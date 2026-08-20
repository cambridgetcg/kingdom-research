import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { importPollEnvelope, validatePollEnvelope } from '../src/captures.mjs'
import { buildSnapshot, snapshotInvariantIssues } from '../src/ingest.mjs'
import { ROOT, canonicalJson, readJson } from '../src/io.mjs'
import { pollSource } from '../src/live.mjs'

const sources = readJson(join(ROOT, 'sources', 'manifest.json')).sources
const watchlists = readJson(join(ROOT, 'watchlists', 'manifest.json')).watchlists
const crossref = sources.find((item) => item.id === 'crossref')
const watchlist = watchlists.find((item) => item.id === 'interpretable-reasoning')

test('checked-in public snapshot is the deterministic captured-live projection', () => {
  const checkedIn = readJson(join(ROOT, 'public', 'research.json'), 8 * 1024 * 1024)
  const rebuilt = buildSnapshot({ includeFixtures: false, includeCaptures: true })
  assert.equal(canonicalJson(checkedIn), canonicalJson(rebuilt))
  assert.equal(checkedIn.mode, 'captured-live-observatory')
  assert.ok(checkedIn.observations.length > 0)
  assert.ok(checkedIn.observations.every((item) => item.synthetic === false))
  assert.equal(checkedIn.generatedFrom.fixtureSetReceipt, null)
  assert.equal(checkedIn.boundaries.captureProvenance, 'imported-live-captures')
})

function responseJson(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function record() {
  return {
    DOI: '10.1234/captured.live', URL: 'https://doi.org/10.1234/captured.live',
    title: ['Mechanistic interpretability captured live metadata'], author: [],
    published: { 'date-parts': [[2026, 8, 20]] }, created: { 'date-time': '2026-08-20T09:00:00Z' },
    indexed: { 'date-time': '2026-08-20T10:00:00Z' }, type: 'journal-article',
  }
}

async function envelope({ empty = false, watermark = '2026-08-20T00:00:00Z', observedAt = '2026-08-20T15:00:00Z' } = {}) {
  return pollSource({
    source: crossref, watchlist, watermark, pages: 1, items: 2, mailto: 'operator@example.org',
    now: () => new Date(observedAt),
    fetchImpl: async () => responseJson({ message: { items: empty ? [] : [record()], 'next-cursor': 'provider-always-emits-one' } }),
  })
}

function countJsonFiles(path) {
  let count = 0
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(current, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.json')) count += 1
    }
  }
  visit(path)
  return count
}

test('import is explicit, append-only, idempotent, live-only, and never promotes', async () => {
  const root = mkdtempSync(join(ROOT, '.capture-test-'))
  const captureDirectory = join(root, 'captures')
  const outputPath = join(root, 'public', 'research.json')
  try {
    const captured = await envelope()
    assert.equal(validatePollEnvelope(captured), captured)
    const first = importPollEnvelope(captured, { captureDirectory, outputPath })
    assert.equal(first.captureWritten, true)
    assert.equal(first.mode, 'captured-live-observatory')
    assert.equal(first.evaluated, false)
    assert.equal(first.adopted, false)
    assert.equal(first.useAuthorized, false)
    assert.equal(first.moduleCreated, false)
    assert.equal(first.guestAdmitted, false)

    const second = importPollEnvelope(captured, { captureDirectory, outputPath })
    assert.equal(second.captureWritten, false)
    assert.equal(countJsonFiles(captureDirectory), 1)

    const snapshot = buildSnapshot({ captureDirectory, includeFixtures: false })
    assert.equal(snapshot.mode, 'captured-live-observatory')
    assert.ok(snapshot.observations.length > 0)
    assert.ok(snapshot.observations.every((item) => item.synthetic === false && item.inert === true))
    assert.equal(snapshot.generatedFrom.fixtureSetReceipt, null)
    assert.equal(snapshot.boundaries.buildNetworkUsed, false)
    assert.equal(snapshot.boundaries.liveHarvestNetworkObserved, true)
    assert.deepEqual(snapshotInvariantIssues(snapshot), [])
    assert.deepEqual(readJson(outputPath), snapshot)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty latest delta cannot erase the latest non-empty lane', async () => {
  const root = mkdtempSync(join(ROOT, '.capture-empty-test-'))
  const captureDirectory = join(root, 'captures')
  const outputPath = join(root, 'research.json')
  try {
    const initial = await envelope()
    importPollEnvelope(initial, { captureDirectory, outputPath })
    const empty = await envelope({ empty: true, watermark: initial.watermarkAfter, observedAt: '2026-08-20T16:00:00Z' })
    const report = importPollEnvelope(empty, { captureDirectory, outputPath })
    assert.equal(report.captureWritten, true)
    assert.equal(countJsonFiles(captureDirectory), 2)
    const snapshot = buildSnapshot({ captureDirectory, includeFixtures: false })
    assert.equal(snapshot.observations.length, 1)
    assert.equal(snapshot.observations[0].identifiers.some((item) => item.value === '10.1234/captured.live'), true)
    assert.equal(snapshot.generatedFrom.captureProjection.selectedCaptureFiles, 2)
    assert.equal(snapshot.generatedFrom.captureProjection.policy, 'latest-and-latest-nonempty-per-lane-plus-30-day-integrity-v0.1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('captured envelopes reject provenance, rights, and clock tampering', async () => {
  const captured = await envelope()
  const wrongQuery = structuredClone(captured)
  wrongQuery.queryProvenance.terms = ['invented', 'caller', 'query']
  assert.throws(() => validatePollEnvelope(wrongQuery), /reviewed watchlist terms|query receipt/u)

  const wrongRights = structuredClone(captured)
  wrongRights.sourceRights.metadataClaim = 'caller assertion'
  assert.throws(() => validatePollEnvelope(wrongRights), /source rights/u)

  const future = structuredClone(captured)
  future.observations[0].upstreamUpdatedAt = '2026-08-21T00:00:00Z'
  assert.throws(() => validatePollEnvelope(future), /future updated time/u)

  const nonterminalAdvance = structuredClone(captured)
  nonterminalAdvance.nextCursor = 'kr1.fake'
  nonterminalAdvance.watermarkAfter = '2026-08-20T10:00:00Z'
  assert.throws(() => validatePollEnvelope(nonterminalAdvance), /nonterminal cursor page/u)
})

test('snapshot mode and provenance invariants reject independently valid but inconsistent fields', () => {
  const synthetic = buildSnapshot({ includeFixtures: true, includeCaptures: false })
  const tamperedSynthetic = structuredClone(synthetic)
  tamperedSynthetic.boundaries.liveHarvestNetworkObserved = true
  assert.ok(snapshotInvariantIssues(tamperedSynthetic).length > 0)

  const wrongMode = structuredClone(synthetic)
  wrongMode.mode = 'captured-live-observatory'
  assert.ok(snapshotInvariantIssues(wrongMode).length >= 3)
})
