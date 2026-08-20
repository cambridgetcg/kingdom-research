import { join, relative } from 'node:path'

import { pollEnvelopeInvariantIssues } from './capture-invariants.mjs'
import { buildSnapshot, ValidationError } from './ingest.mjs'
import {
  ROOT,
  appendOnlyWriteInsideRoot,
  atomicWriteInsideRoot,
  canonicalJson,
  prettyCanonicalJson,
  readJson,
  sha256Json,
} from './io.mjs'
import { loadSchemaRegistry, validateWithSchema } from './schema-validator.mjs'

const SOURCE_MANIFEST_PATH = join(ROOT, 'sources', 'manifest.json')
const WATCHLIST_MANIFEST_PATH = join(ROOT, 'watchlists', 'manifest.json')
export const CAPTURE_ROOT = join(ROOT, 'captures')
export const PUBLIC_SNAPSHOT_PATH = join(ROOT, 'public', 'research.json')

function fail(issues) {
  throw new ValidationError('poll envelope invariants', issues)
}

export { pollEnvelopeInvariantIssues }

export function validatePollEnvelope(envelope) {
  const registry = loadSchemaRegistry()
  const schemaIssues = validateWithSchema(envelope, 'poll-result.schema.json', registry)
  if (schemaIssues.length > 0) throw new ValidationError('poll-result.schema.json', schemaIssues)
  const sources = readJson(SOURCE_MANIFEST_PATH)
  const watchlists = readJson(WATCHLIST_MANIFEST_PATH)
  const invariantIssues = pollEnvelopeInvariantIssues(envelope, { sources, watchlists })
  if (invariantIssues.length > 0) fail(invariantIssues)
  return envelope
}

function captureName(envelope) {
  const stamp = envelope.observedAt.replaceAll('-', '').replaceAll(':', '')
  const digest = sha256Json(envelope).slice('sha256:'.length, 'sha256:'.length + 16)
  return join(envelope.sourceId, envelope.queryProvenance.watchlistId, `${stamp}-${digest}.json`)
}

export function importPollEnvelope(envelope, {
  captureDirectory = CAPTURE_ROOT,
  outputPath = PUBLIC_SNAPSHOT_PATH,
} = {}) {
  validatePollEnvelope(envelope)
  if (envelope.observations.length === 0) {
    try {
      buildSnapshot({ captureDirectory, includeFixtures: false })
    } catch {
      throw new TypeError('an empty capture cannot initialize a live-only public snapshot')
    }
  }
  const relativeCapture = captureName(envelope)
  const capturePath = join(captureDirectory, relativeCapture)
  const document = prettyCanonicalJson(envelope)
  const written = appendOnlyWriteInsideRoot(capturePath, document)
  if (!written && canonicalJson(readJson(capturePath, 4 * 1024 * 1024)) !== canonicalJson(envelope)) {
    throw new TypeError('existing append-only capture path has different content')
  }
  const snapshot = buildSnapshot({ captureDirectory, includeFixtures: false })
  atomicWriteInsideRoot(outputPath, prettyCanonicalJson(snapshot))
  return {
    schema: 'kingdom.research-import-report/0.1',
    capturePath: relative(ROOT, capturePath).replaceAll('\\', '/'),
    captureReceipt: sha256Json(envelope),
    captureWritten: written,
    publicPath: relative(ROOT, outputPath).replaceAll('\\', '/'),
    publicReceipt: sha256Json(snapshot),
    mode: snapshot.mode,
    observations: snapshot.observations.length,
    works: snapshot.works.length,
    signals: snapshot.signals.length,
    evaluated: false,
    adopted: false,
    useAuthorized: false,
    moduleCreated: false,
    guestAdmitted: false,
  }
}
