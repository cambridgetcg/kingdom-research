import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

import { normalizePayload } from './adapters.mjs'
import { pollEnvelopeInvariantIssues } from './capture-invariants.mjs'
import {
  ROOT,
  canonicalJson,
  readBoundedBytes,
  readJson,
  sha256Bytes,
  sha256Json,
} from './io.mjs'
import {
  loadSchemaRegistry,
  schemaDocumentIssues,
  validateWithSchema,
} from './schema-validator.mjs'

export const PIPELINE_VERSION = '0.1.0'

const SOURCE_MANIFEST_PATH = join(ROOT, 'sources', 'manifest.json')
const WATCHLIST_MANIFEST_PATH = join(ROOT, 'watchlists', 'manifest.json')
const FIXTURE_MANIFEST_PATH = join(ROOT, 'fixtures', 'manifest.json')
const CAPTURE_ROOT = join(ROOT, 'captures')

function assertValid(value, schema, registry) {
  const issues = validateWithSchema(value, schema, registry)
  if (issues.length > 0) throw new ValidationError(schema, issues)
}

export class ValidationError extends Error {
  constructor(schema, issues) {
    super(`${schema} validation failed: ${issues.slice(0, 8).join('; ')}`)
    this.name = 'ValidationError'
    this.schema = schema
    this.issues = issues
  }
}

export function snapshotInvariantIssues(snapshot) {
  const issues = []
  const syntheticCount = snapshot.observations.filter((item) => item.synthetic === true).length
  const liveCount = snapshot.observations.filter((item) => item.synthetic === false).length
  if (snapshot.boundaries?.buildNetworkUsed !== false) issues.push('snapshot build must remain network-free')
  if (snapshot.observations.some((item) => item.observedAt > snapshot.asOf)) issues.push('observation occurs after snapshot asOf')
  if (snapshot.mode === 'synthetic-fixture-observatory') {
    if (snapshot.generatedFrom.fixtureSetReceipt === null) issues.push('synthetic mode requires fixture receipt')
    if (snapshot.generatedFrom.captureSetReceipt !== null) issues.push('synthetic mode forbids capture receipt')
    if (snapshot.generatedFrom.captureProjection !== null) issues.push('synthetic mode forbids capture projection')
    if (snapshot.boundaries.liveHarvestNetworkObserved !== false) issues.push('synthetic mode forbids live harvest provenance')
    if (snapshot.boundaries.captureProvenance !== 'fixtures-only') issues.push('synthetic mode requires fixtures-only provenance')
    if (liveCount !== 0 || syntheticCount < 1) issues.push('synthetic mode requires only synthetic observations')
  } else if (snapshot.mode === 'captured-live-observatory') {
    if (snapshot.generatedFrom.fixtureSetReceipt !== null) issues.push('captured-live mode forbids fixture receipt')
    if (snapshot.generatedFrom.captureSetReceipt === null) issues.push('captured-live mode requires capture receipt')
    if (snapshot.generatedFrom.captureProjection === null) issues.push('captured-live mode requires capture projection')
    if (snapshot.boundaries.liveHarvestNetworkObserved !== true) issues.push('captured-live mode requires live harvest provenance')
    if (snapshot.boundaries.captureProvenance !== 'imported-live-captures') issues.push('captured-live mode requires imported-live-captures provenance')
    if (syntheticCount !== 0 || liveCount < 1) issues.push('captured-live mode requires only non-synthetic observations')
  } else if (snapshot.mode === 'mixed-observatory') {
    if (snapshot.generatedFrom.fixtureSetReceipt === null || snapshot.generatedFrom.captureSetReceipt === null) issues.push('mixed mode requires fixture and capture receipts')
    if (snapshot.generatedFrom.captureProjection === null) issues.push('mixed mode requires capture projection')
    if (snapshot.boundaries.liveHarvestNetworkObserved !== true) issues.push('mixed mode requires live harvest provenance')
    if (snapshot.boundaries.captureProvenance !== 'mixed-fixtures-and-live-captures') issues.push('mixed mode requires mixed capture provenance')
    if (syntheticCount < 1 || liveCount < 1) issues.push('mixed mode requires synthetic and non-synthetic observations')
  }
  return issues
}

function sortUnique(values) {
  return [...new Set(values)].sort()
}

function identifierKey(item) {
  return `${item.scheme}:${item.value}`
}

function compareIdentifier(left, right) {
  const rank = new Map([
    ['doi', 0], ['pmid', 1], ['pmcid', 2], ['arxiv', 3], ['nct', 4],
    ['openalex', 5], ['datacite-doi', 6], ['source', 7],
  ])
  return (rank.get(left.scheme) ?? 99) - (rank.get(right.scheme) ?? 99)
    || left.value.localeCompare(right.value)
}

function captureFiles(directory = CAPTURE_ROOT) {
  if (!existsSync(directory)) return []
  const result = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.json')) result.push(path)
      else if (entry.isSymbolicLink()) throw new TypeError('capture tree must not contain symbolic links')
    }
  }
  visit(directory)
  return result
}

function loadManifests(registry) {
  const sources = readJson(SOURCE_MANIFEST_PATH)
  const watchlists = readJson(WATCHLIST_MANIFEST_PATH)
  const fixtureSet = readJson(FIXTURE_MANIFEST_PATH)
  assertValid(sources, 'source-manifest.schema.json', registry)
  assertValid(watchlists, 'watchlist-manifest.schema.json', registry)
  assertValid(fixtureSet, 'fixture-set.schema.json', registry)

  const sourceIds = sources.sources.map((source) => source.id)
  if (new Set(sourceIds).size !== sourceIds.length) throw new TypeError('source IDs must be unique')
  const watchlistIds = watchlists.watchlists.map((watchlist) => watchlist.id)
  if (new Set(watchlistIds).size !== watchlistIds.length) throw new TypeError('watchlist IDs must be unique')
  const fixtureIds = fixtureSet.fixtures.map((fixture) => fixture.id)
  if (new Set(fixtureIds).size !== fixtureIds.length) throw new TypeError('fixture IDs must be unique')
  for (const fixture of fixtureSet.fixtures) {
    if (!sourceIds.includes(fixture.sourceId)) throw new TypeError(`fixture ${fixture.id} names unknown source`)
  }
  return { sources, watchlists, fixtureSet }
}

function loadFixtureObservations(fixtureSet, registry) {
  const observations = []
  for (const fixture of fixtureSet.fixtures) {
    const path = join(ROOT, 'fixtures', fixture.path)
    const bytes = readBoundedBytes(path)
    const normalized = normalizePayload({
      adapter: fixture.adapter,
      sourceId: fixture.sourceId,
      observedAt: fixture.observedAt,
      bytes,
      synthetic: true,
    })
    for (const item of normalized.observations) {
      assertValid(item, 'observation.schema.json', registry)
      observations.push(item)
    }
  }
  return observations
}

function loadCaptureObservations(sources, watchlists, registry, directory = CAPTURE_ROOT) {
  const sourceIds = new Set(sources.sources.map((source) => source.id))
  const inputs = []
  for (const path of captureFiles(directory)) {
    const bytes = readBoundedBytes(path, 4 * 1024 * 1024)
    const envelope = readJson(path, 4 * 1024 * 1024)
    assertValid(envelope, 'poll-result.schema.json', registry)
    const invariantIssues = pollEnvelopeInvariantIssues(envelope, { sources, watchlists })
    if (invariantIssues.length > 0) throw new ValidationError(`capture invariants for ${relative(ROOT, path)}`, invariantIssues)
    if (!sourceIds.has(envelope.sourceId)) throw new TypeError(`capture names unknown source ${envelope.sourceId}`)
    if (envelope.effects.networkRequests < 1) throw new TypeError('live capture must report at least one network request')
    for (const item of envelope.observations) {
      if (item.synthetic !== false || item.inert !== true) throw new TypeError('capture observations must be live and inert')
      if (item.sourceId !== envelope.sourceId) throw new TypeError('capture observation source mismatch')
      if (item.observedAt > envelope.observedAt) throw new TypeError('capture observation occurs after its envelope')
    }
    inputs.push({
      path: relative(ROOT, path).replaceAll('\\', '/'),
      receipt: sha256Bytes(bytes),
      observedAt: envelope.observedAt,
      sourceId: envelope.sourceId,
      watchlistId: envelope.queryProvenance.watchlistId,
      envelope,
    })
  }
  return { inputs }
}

function projectCaptures(inputs, maximumObservations) {
  if (inputs.length === 0) return {
    observations: [],
    projection: null,
  }
  const latestByLane = new Map()
  const latestNonEmptyByLane = new Map()
  for (const input of inputs) {
    const key = `${input.sourceId}\u0000${input.watchlistId}`
    const existing = latestByLane.get(key)
    if (existing === undefined
      || input.observedAt > existing.observedAt
      || (input.observedAt === existing.observedAt && input.receipt > existing.receipt)) {
      latestByLane.set(key, input)
    }
    if (input.envelope.observations.length > 0) {
      const existingNonEmpty = latestNonEmptyByLane.get(key)
      if (existingNonEmpty === undefined
        || input.observedAt > existingNonEmpty.observedAt
        || (input.observedAt === existingNonEmpty.observedAt && input.receipt > existingNonEmpty.receipt)) {
        latestNonEmptyByLane.set(key, input)
      }
    }
  }
  const latestObservedAt = inputs.map((input) => input.observedAt).sort().at(-1)
  const integrityFloor = new Date(Date.parse(latestObservedAt) - 30 * 86_400_000).toISOString().replace(/\.000Z$/u, 'Z')
  const selectedByReceipt = new Map(
    [...latestByLane.values(), ...latestNonEmptyByLane.values()].map((input) => [input.receipt, input]),
  )
  for (const input of inputs) {
    if (input.sourceId === 'crossref-integrity' && input.observedAt >= integrityFloor) {
      selectedByReceipt.set(input.receipt, input)
    }
  }
  const selected = [...selectedByReceipt.values()].sort((left, right) => left.path.localeCompare(right.path))
  const available = deduplicateObservations(selected.flatMap((input) => input.envelope.observations))
    .sort((left, right) => {
      const integrity = Number(right.sourceId === 'crossref-integrity') - Number(left.sourceId === 'crossref-integrity')
      return integrity || right.observedAt.localeCompare(left.observedAt) || left.id.localeCompare(right.id)
    })
  const observations = available.slice(0, maximumObservations).sort((left, right) => left.id.localeCompare(right.id))
  const projectionBasis = {
    policy: 'latest-and-latest-nonempty-per-lane-plus-30-day-integrity-v0.1',
    selected: selected.map(({ path, receipt, observedAt, sourceId, watchlistId }) => ({ path, receipt, observedAt, sourceId, watchlistId })),
    publishedObservationIds: observations.map((item) => item.id),
  }
  return {
    observations,
    projection: {
      policy: projectionBasis.policy,
      retainedCaptureFiles: inputs.length,
      selectedCaptureFiles: selected.length,
      availableObservations: available.length,
      publishedObservations: observations.length,
      truncatedObservations: available.length - observations.length,
      projectionReceipt: sha256Json(projectionBasis),
    },
  }
}

function deduplicateObservations(items) {
  const byId = new Map()
  for (const item of items) {
    const existing = byId.get(item.id)
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(item)) {
      throw new TypeError(`observation ID collision ${item.id}`)
    }
    byId.set(item.id, item)
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

class UnionFind {
  constructor(size) { this.parent = Array.from({ length: size }, (_, index) => index) }
  find(index) {
    while (this.parent[index] !== index) {
      this.parent[index] = this.parent[this.parent[index]]
      index = this.parent[index]
    }
    return index
  }
  union(left, right) {
    const a = this.find(left)
    const b = this.find(right)
    if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b)
  }
}

function groupObservations(observations) {
  const union = new UnionFind(observations.length)
  const firstByIdentifier = new Map()
  observations.forEach((item, index) => {
    for (const id of item.identifiers) {
      const key = identifierKey(id)
      if (firstByIdentifier.has(key)) union.union(index, firstByIdentifier.get(key))
      else firstByIdentifier.set(key, index)
    }
  })
  const groups = new Map()
  observations.forEach((item, index) => {
    const root = union.find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(item)
  })
  return [...groups.values()]
}

function statusFrom(values) {
  const rank = new Map([['retracted', 0], ['withdrawn', 1], ['corrected', 2], ['active', 3], ['unknown', 4]])
  return [...values].sort((left, right) => (rank.get(left) ?? 99) - (rank.get(right) ?? 99))[0] ?? 'unknown'
}

function makeWorks(observations, sourceById) {
  return groupObservations(observations).map((group) => {
    const ids = new Map()
    for (const item of group) for (const id of item.identifiers) ids.set(identifierKey(id), id)
    const identifierList = [...ids.values()].sort(compareIdentifier)
    const primaryIdentifier = identifierList[0]
    const workId = `work:${sha256Bytes(Buffer.from(identifierKey(primaryIdentifier))).slice(7, 27)}`
    const contentObservations = group.filter((item) => item.recordType !== 'status-update')
    const candidates = contentObservations.length > 0 ? contentObservations : group
    candidates.sort((left, right) => {
      const leftAuthority = sourceById.get(left.sourceId)?.authority.kind ?? 'aggregated'
      const rightAuthority = sourceById.get(right.sourceId)?.authority.kind ?? 'aggregated'
      const rank = { canonical: 0, 'authoritative-domain': 1, aggregated: 2, 'derived-integrity': 3 }
      return rank[leftAuthority] - rank[rightAuthority]
        || right.observedAt.localeCompare(left.observedAt)
        || left.id.localeCompare(right.id)
    })
    const relations = group.flatMap((item) => item.relations).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    const dates = group.map((item) => item.publishedOn).filter(Boolean).sort()
    return {
      schema: 'kingdom.research-work/0.1',
      id: workId,
      primaryIdentifier,
      identifiers: identifierList,
      title: candidates[0].title,
      authors: sortUnique(group.flatMap((item) => item.authors.map((author) => author.name))),
      recordTypes: sortUnique(group.map((item) => item.recordType)),
      firstPublishedOn: dates[0] ?? null,
      latestObservedAt: group.map((item) => item.observedAt).sort().at(-1),
      languages: sortUnique(group.map((item) => item.language).filter(Boolean)),
      subjects: sortUnique(group.flatMap((item) => item.subjects)),
      reviewStates: sortUnique(group.map((item) => item.reviewState)),
      status: statusFrom(group.map((item) => item.status)),
      itemLicenses: sortUnique(group.map((item) => item.itemLicense).filter(Boolean)),
      versions: group.map((item) => ({
        label: item.version,
        observedAt: item.observedAt,
        publishedOn: item.publishedOn,
        status: item.status,
        observationId: item.id,
      })).sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.observationId.localeCompare(right.observationId)),
      relations,
      observationIds: group.map((item) => item.id).sort(),
      sourceIds: sortUnique(group.map((item) => item.sourceId)),
      lifecycle: {
        discovery: 'observed',
        evaluation: 'not-performed',
        adoption: 'not-recorded',
        use: 'not-authorized',
      },
      paths: {
        module: { state: 'not-proposed', requiresSeparateEvaluation: true, requiresSeparateAdoption: true, requiresSeparateUseAuthority: true },
        guest: { state: 'not-proposed', requiresSeparateEvaluation: true, requiresSeparateAdoption: true, requiresSeparateUseAuthority: true },
      },
    }
  }).sort((left, right) => left.id.localeCompare(right.id))
}

function signalId(type, parts) {
  const digest = sha256Bytes(Buffer.from([type, ...parts].join('\u0000'))).slice(7, 23)
  return `signal:${type}:${digest}`
}

function sourceAuthorityLevel(work, sourceById) {
  const kinds = work.sourceIds.map((id) => sourceById.get(id)?.authority.kind)
  if (kinds.includes('canonical')) return 'high'
  if (kinds.includes('authoritative-domain')) return 'medium'
  return 'low'
}

function reviewLevel(work) {
  if (work.reviewStates.includes('peer-reviewed')) return 'high'
  if (work.reviewStates.includes('dataset') || work.reviewStates.includes('registered-study')) return 'medium'
  if (work.reviewStates.includes('preprint')) return 'low'
  return 'unknown'
}

function freshnessLevel(work, asOf) {
  if (work.firstPublishedOn === null) return 'unknown'
  const days = Math.floor((Date.parse(asOf) - Date.parse(`${work.firstPublishedOn}T00:00:00Z`)) / 86_400_000)
  if (days <= 30) return 'high'
  if (days <= 180) return 'medium'
  return 'low'
}

function itemRightsFactor(work) {
  if (work.itemLicenses.length === 0) {
    return { level: 'unknown', evidence: ['item-level licence absent'] }
  }
  const recognized = work.itemLicenses.filter((value) => /^(?:CC0(?:-1\.0)?|CC-BY(?:-[0-9.]+)?)$/iu.test(value)
    || /^https:\/\/creativecommons\.org\/(?:publicdomain\/zero|licenses\/by)\//iu.test(value))
  if (recognized.length > 0) {
    return { level: 'medium', evidence: recognized.map((value) => `reported item licence:${value}`) }
  }
  return { level: 'unknown', evidence: work.itemLicenses.map((value) => `uninterpreted item licence:${value}`) }
}

function factorVector(work, watchlist, matchedTerms, asOf, sourceById) {
  return watchlist.priorityFactors.map(({ factor, reason }) => {
    if (factor === 'named-need-fit') return { factor, level: 'high', evidence: matchedTerms, reason }
    if (factor === 'freshness') return { factor, level: freshnessLevel(work, asOf), evidence: [work.firstPublishedOn ?? 'publication date absent'], reason }
    if (factor === 'source-authority') return { factor, level: sourceAuthorityLevel(work, sourceById), evidence: work.sourceIds, reason }
    if (factor === 'review-state') return { factor, level: reviewLevel(work), evidence: work.reviewStates, reason }
    if (factor === 'integrity') return { factor, level: work.status === 'retracted' ? 'blocking' : work.status === 'corrected' || work.status === 'withdrawn' ? 'low' : 'unknown', evidence: [work.status], reason }
    const rights = itemRightsFactor(work)
    return { factor, level: rights.level, evidence: rights.evidence, reason: `${reason} Source-metadata reuse terms are tracked separately and do not grant rights to the linked object.` }
  })
}

function makeSignals(works, observations, watchlists, sourceById, asOf) {
  const signals = []
  const workById = new Map(works.map((work) => [work.id, work]))
  const workByIdentifier = new Map()
  for (const work of works) for (const id of work.identifiers) workByIdentifier.set(identifierKey(id), work)
  const observationById = new Map(observations.map((item) => [item.id, item]))

  for (const work of works) {
    if (work.sourceIds.length > 1) {
      signals.push({
        schema: 'kingdom.research-signal/0.1',
        id: signalId('source-corroboration', [work.id, ...work.sourceIds]),
        type: 'source-corroboration', workIds: [work.id], observedAt: work.latestObservedAt,
        severity: 'info', headline: `${work.sourceIds.length} sources report exact identifiers for this work`,
        reasons: ['Exact shared identifiers connect the observations; this does not independently verify the research claim.'],
        sourceObservationIds: work.observationIds, watchlistId: null, factors: [], authorizesAction: false,
      })
    }
    if (work.versions.length > 1) {
      signals.push({
        schema: 'kingdom.research-signal/0.1',
        id: signalId('version-activity', [work.id, ...work.observationIds]),
        type: 'version-activity', workIds: [work.id], observedAt: work.latestObservedAt,
        severity: 'watch', headline: `${work.versions.length} source observations or versions are preserved`,
        reasons: ['The observations remain separate even when exact identifiers resolve to one work.'],
        sourceObservationIds: work.observationIds, watchlistId: null, factors: [], authorizesAction: false,
      })
    }
  }

  for (const sourceWork of works) {
    for (const relation of sourceWork.relations) {
      const target = workByIdentifier.get(identifierKey(relation.identifier))
      if (relation.type === 'retracts' || relation.type === 'corrects') {
        if (target !== undefined) target.status = relation.type === 'retracts' ? 'retracted' : target.status === 'active' ? 'corrected' : target.status
        const workIds = sortUnique([sourceWork.id, ...(target ? [target.id] : [])])
        const relationObservationIds = sourceWork.observationIds.filter((id) => observationById.get(id)?.relations.some((candidate) => canonicalJson(candidate) === canonicalJson(relation)))
        signals.push({
          schema: 'kingdom.research-signal/0.1',
          id: signalId('integrity-alert', [sourceWork.id, identifierKey(relation.identifier), relation.source ?? '', relation.recordId ?? '']),
          type: 'integrity-alert', workIds, observedAt: relation.assertedAt ?? sourceWork.latestObservedAt,
          severity: relation.type === 'retracts' ? 'blocking' : 'attention',
          headline: `${relation.type === 'retracts' ? 'Retraction' : 'Correction'} assertion for ${relation.identifier.value}`,
          reasons: [`Source assertion retained as ${relation.source ?? 'unspecified source'}${relation.recordId ? ` record ${relation.recordId}` : ''}.`, 'Duplicate publisher and Retraction Watch assertions remain distinct.'],
          sourceObservationIds: relationObservationIds.length > 0 ? relationObservationIds : sourceWork.observationIds,
          watchlistId: null,
          factors: [{ factor: 'integrity', level: relation.type === 'retracts' ? 'blocking' : 'low', evidence: [relation.source ?? 'source absent', relation.recordId ?? 'record ID absent'], reason: 'Status evidence must remain visible and cannot be averaged into a scalar score.' }],
          authorizesAction: false,
        })
      } else if (['is-preprint-of', 'has-preprint', 'is-version-of', 'has-version', 'is-supplement-to', 'is-supplemented-by', 'is-updated-by', 'is-corrected-by', 'is-retracted-by'].includes(relation.type)) {
        signals.push({
          schema: 'kingdom.research-signal/0.1',
          id: signalId('publication-link', [sourceWork.id, relation.type, identifierKey(relation.identifier), relation.source ?? '']),
          type: 'publication-link', workIds: sortUnique([sourceWork.id, ...(target ? [target.id] : [])]), observedAt: relation.assertedAt ?? sourceWork.latestObservedAt,
          severity: 'info', headline: `Explicit ${relation.type} relation to ${relation.identifier.value}`,
          reasons: ['The source relation creates an edge; it does not silently merge the records.'],
          sourceObservationIds: sourceWork.observationIds, watchlistId: null, factors: [], authorizesAction: false,
        })
      }
    }
  }

  for (const work of works) {
    const haystack = `${work.title}\n${work.subjects.join('\n')}`.toLocaleLowerCase('en-US')
    for (const watchlist of watchlists.watchlists) {
      const matched = watchlist.keywords.filter((keyword) => haystack.includes(keyword.toLocaleLowerCase('en-US'))).sort()
      if (matched.length === 0) continue
      signals.push({
        schema: 'kingdom.research-signal/0.1',
        id: signalId('watchlist-match', [work.id, watchlist.id, ...matched]),
        type: 'watchlist-match', workIds: [work.id], observedAt: work.latestObservedAt,
        severity: work.status === 'retracted' ? 'blocking' : 'attention',
        headline: `${work.title} matches ${watchlist.name}`,
        reasons: [`Matched reviewed English terms: ${matched.join(', ')}.`, 'The match orders attention only; it is not evaluation, adoption, or use authority.'],
        sourceObservationIds: work.observationIds,
        watchlistId: watchlist.id,
        factors: factorVector(work, watchlist, matched, asOf, sourceById),
        authorizesAction: false,
      })
    }
  }

  const byId = new Map()
  for (const signal of signals) {
    signal.workIds = signal.workIds.filter((id) => workById.has(id))
    const existing = byId.get(signal.id)
    if (existing === undefined) {
      byId.set(signal.id, signal)
      continue
    }
    existing.workIds = sortUnique([...existing.workIds, ...signal.workIds])
    existing.sourceObservationIds = sortUnique([...existing.sourceObservationIds, ...signal.sourceObservationIds])
    existing.reasons = sortUnique([...existing.reasons, ...signal.reasons])
    existing.observedAt = [existing.observedAt, signal.observedAt].sort().at(-1)
    const factorMap = new Map([...existing.factors, ...signal.factors].map((factor) => [canonicalJson(factor), factor]))
    existing.factors = [...factorMap.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function buildSnapshot({ captureDirectory = CAPTURE_ROOT, includeFixtures = true, includeCaptures = true } = {}) {
  if (!includeFixtures && !includeCaptures) throw new TypeError('snapshot must include fixtures or imported captures')
  const registry = loadSchemaRegistry()
  const schemaIssues = schemaDocumentIssues(registry)
  if (schemaIssues.length > 0) throw new ValidationError('schema documents', schemaIssues)
  const { sources, watchlists, fixtureSet } = loadManifests(registry)
  const fixtureObservations = includeFixtures ? loadFixtureObservations(fixtureSet, registry) : []
  const captures = includeCaptures ? loadCaptureObservations(sources, watchlists, registry, captureDirectory) : { inputs: [] }
  const projectedCaptures = projectCaptures(captures.inputs, 256 - fixtureObservations.length)
  const observations = deduplicateObservations([...fixtureObservations, ...projectedCaptures.observations])
  if (!includeFixtures && observations.length === 0) throw new TypeError('live-only build requires at least one imported live observation')
  const asOfCandidates = [
    ...(includeFixtures ? [fixtureSet.asOf] : []),
    ...captures.inputs.map((item) => item.observedAt),
    ...observations.map((item) => item.observedAt),
  ]
  const asOf = asOfCandidates.sort().at(-1)
  if (observations.some((item) => item.observedAt > asOf)) throw new TypeError('observation occurs after snapshot asOf')
  const sourceById = new Map(sources.sources.map((source) => [source.id, source]))
  const works = makeWorks(observations, sourceById)
  const signals = makeSignals(works, observations, watchlists, sourceById, asOf)
  for (const work of works) assertValid(work, 'work.schema.json', registry)
  for (const signal of signals) assertValid(signal, 'signal.schema.json', registry)
  const hasCaptures = captures.inputs.length > 0
  const captureInputManifest = captures.inputs.map(({ envelope, ...input }) => input)
  const mode = includeFixtures
    ? hasCaptures ? 'mixed-observatory' : 'synthetic-fixture-observatory'
    : 'captured-live-observatory'
  const snapshot = {
    schema: 'kingdom.research-public-snapshot/0.1',
    asOf,
    mode,
    metadataOnly: true,
    generatedFrom: {
      sourceManifestReceipt: sha256Json(sources),
      watchlistManifestReceipt: sha256Json(watchlists),
      fixtureSetReceipt: includeFixtures ? sha256Json(fixtureSet) : null,
      captureSetReceipt: hasCaptures ? sha256Json(captureInputManifest) : null,
      captureProjection: projectedCaptures.projection,
      pipelineVersion: PIPELINE_VERSION,
    },
    sources: [...sources.sources].sort((left, right) => left.id.localeCompare(right.id)),
    watchlists: [...watchlists.watchlists].sort((left, right) => left.id.localeCompare(right.id)),
    observations,
    works,
    signals,
    boundaries: {
      buildNetworkUsed: false,
      liveHarvestNetworkObserved: hasCaptures,
      captureProvenance: includeFixtures
        ? hasCaptures ? 'mixed-fixtures-and-live-captures' : 'fixtures-only'
        : 'imported-live-captures',
      fullTextIncluded: false,
      artifactExecution: false,
      evaluationPerformed: false,
      adoptionRecorded: false,
      useAuthorized: false,
      moduleCreated: false,
      guestAdmitted: false,
    },
  }
  assertValid(snapshot, 'public-snapshot.schema.json', registry)
  const invariantIssues = snapshotInvariantIssues(snapshot)
  if (invariantIssues.length > 0) throw new ValidationError('public snapshot invariants', invariantIssues)
  return snapshot
}

export function validateBundledData(options = {}) {
  const snapshot = buildSnapshot(options)
  return {
    schema: 'kingdom.research-validation-report/0.1',
    state: 'valid',
    schemas: [...loadSchemaRegistry().keys()].filter((name) => name.endsWith('.json') && name === basename(name)).length,
    sources: snapshot.sources.length,
    watchlists: snapshot.watchlists.length,
    observations: snapshot.observations.length,
    works: snapshot.works.length,
    signals: snapshot.signals.length,
    liveCaptures: snapshot.observations.filter((item) => item.synthetic === false).length,
    boundaries: snapshot.boundaries,
  }
}
