import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePayload } from '../src/adapters.mjs'
import { buildSnapshot, snapshotInvariantIssues, validateBundledData } from '../src/ingest.mjs'
import { canonicalJson, parseJsonBytes, readJson } from '../src/io.mjs'
import { loadSchemaRegistry, schemaDocumentIssues, validateWithSchema } from '../src/schema-validator.mjs'

const OBSERVED = '2026-08-20T15:00:00Z'

function jsonPayload(value) {
  return Buffer.from(JSON.stringify(value))
}

function crossrefItem(overrides = {}) {
  return {
    DOI: '10.1234/example.direction',
    URL: 'http://unsafe.example/path#fragment',
    title: ['Mechanistic interpretability relation semantics'],
    author: [{ given: 'Test', family: 'Author' }],
    published: { 'date-parts': [[2026, 8, 19]] },
    created: { 'date-time': '2026-08-19T10:00:00Z' },
    indexed: { 'date-time': '2026-08-20T10:00:00Z' },
    type: 'journal-article',
    ...overrides,
  }
}

test('bundled schemas and deterministic offline snapshot validate', () => {
  const registry = loadSchemaRegistry()
  assert.deepEqual(schemaDocumentIssues(registry), [])
  const first = buildSnapshot({ includeFixtures: true, includeCaptures: false })
  const second = buildSnapshot({ includeFixtures: true, includeCaptures: false })
  assert.equal(canonicalJson(first), canonicalJson(second))
  assert.deepEqual(validateWithSchema(first, 'public-snapshot.schema.json', registry), [])
  assert.equal(first.mode, 'synthetic-fixture-observatory')
  assert.ok(first.observations.every((item) => item.synthetic && item.inert))
  assert.deepEqual(snapshotInvariantIssues(first), [])
  assert.equal(first.boundaries.evaluationPerformed, false)
  assert.equal(first.boundaries.adoptionRecorded, false)
  assert.equal(first.boundaries.useAuthorized, false)
  assert.equal(first.boundaries.moduleCreated, false)
  assert.equal(first.boundaries.guestAdmitted, false)
  assert.equal(validateBundledData({ includeFixtures: true, includeCaptures: false }).schemas, 10)
})

test('watchlists expose reviewed English terms and factor vectors, never a scalar', () => {
  const snapshot = buildSnapshot({ includeFixtures: true, includeCaptures: false })
  assert.equal(snapshot.watchlists.length, 3)
  for (const watchlist of snapshot.watchlists) {
    assert.equal(watchlist.languageScope.multilingualExpansion.state, 'absent')
    assert.ok(watchlist.keywords.length >= 3)
    assert.equal(Object.hasOwn(watchlist, 'score'), false)
  }
  const interoperability = snapshot.watchlists.find((item) => item.id === 'language-agent-interoperability')
  assert.ok(interoperability.keywords.includes('model context protocol'))
  assert.equal(interoperability.keywords.includes('MCP'), false)
  for (const signal of snapshot.signals) assert.equal(Object.hasOwn(signal, 'score'), false)
  const rightsFactors = snapshot.signals.flatMap((signal) => signal.factors).filter((factor) => factor.factor === 'rights-clarity')
  assert.ok(rightsFactors.length > 0)
  assert.ok(rightsFactors.every((factor) => factor.level !== 'high'))
  assert.ok(rightsFactors.every((factor) => factor.reason.includes('do not grant rights')))
})

test('exact identifiers merge observations while source-local identifiers are namespaced', () => {
  const snapshot = buildSnapshot({ includeFixtures: true, includeCaptures: false })
  const shared = snapshot.works.find((work) => work.identifiers.some((id) => id.scheme === 'doi' && id.value === '10.0000/kingdom.synthetic.001'))
  assert.ok(shared)
  assert.ok(shared.sourceIds.includes('crossref'))
  assert.ok(shared.sourceIds.includes('openalex'))
  assert.ok(shared.observationIds.length >= 2)
  const epmc = snapshot.observations.find((item) => item.sourceId === 'europe-pmc')
  assert.ok(epmc.identifiers.some((id) => id.scheme === 'source' && id.value.startsWith('europe-pmc:')))
})

test('duplicate integrity assertions aggregate signals but preserve source assertions', () => {
  const snapshot = buildSnapshot({ includeFixtures: true, includeCaptures: false })
  const integrityObservations = snapshot.observations.filter((item) => item.sourceId === 'crossref-integrity')
  assert.equal(integrityObservations.length, 1)
  assert.equal(integrityObservations[0].relations.length, 2)
  assert.deepEqual(new Set(integrityObservations[0].relations.map((item) => item.source)), new Set(['publisher', 'retraction-watch']))
  const alerts = snapshot.signals.filter((item) => item.type === 'integrity-alert')
  assert.equal(alerts.length, 2)
  assert.equal(new Set(alerts.map((item) => item.id)).size, alerts.length)
  assert.ok(alerts.some((item) => item.reasons.some((reason) => reason.includes('publisher'))))
  assert.ok(alerts.some((item) => item.reasons.some((reason) => reason.includes('retraction-watch'))))
})

test('strict JSON parsing rejects duplicate keys at every nesting level', () => {
  assert.throws(() => parseJsonBytes(Buffer.from('{"safe":1,"safe":2}')), /duplicate JSON object key/u)
  assert.throws(() => parseJsonBytes(Buffer.from('{"outer":{"x":1,"x":2}}')), /duplicate JSON object key/u)
})

test('Crossref relations preserve direction and malformed depositor URLs fall back safely', () => {
  const payload = {
    message: {
      items: [crossrefItem({
        relation: {
          'has-preprint': [{ id: '10.1234/example.preprint', 'id-type': 'doi' }],
          'is-corrected-by': [{ id: '10.1234/example.correction', 'id-type': 'doi' }],
          'has-version': [{ id: 'local-version', 'id-type': 'other' }],
        },
      })],
      'next-cursor': null,
    },
  }
  const { observations } = normalizePayload({ adapter: 'crossref', sourceId: 'crossref', observedAt: OBSERVED, bytes: jsonPayload(payload), synthetic: false })
  assert.equal(observations[0].recordType, 'publication')
  assert.equal(observations[0].reviewState, 'unknown')
  assert.deepEqual(observations[0].relations.map((item) => item.type), ['has-preprint', 'has-version', 'is-corrected-by'])
  assert.ok(observations[0].relations.find((item) => item.identifier.scheme === 'source').identifier.value.startsWith('crossref:'))
  assert.equal(observations[0].canonicalUrl, 'https://example.invalid/research/10.1234%2Fexample.direction')
})

test('DataCite inverse relations are not coerced to outbound relations', () => {
  const payload = {
    links: { next: null },
    data: [{
      id: '10.1234/datacite.direction',
      attributes: {
        doi: '10.1234/datacite.direction', created: '2026-08-19T00:00:00Z', updated: '2026-08-20T00:00:00Z',
        titles: [{ title: 'Agent security directional relations' }], creators: [], types: { resourceTypeGeneral: 'Dataset' }, subjects: [],
        relatedIdentifiers: [
          { relationType: 'HasVersion', relatedIdentifierType: 'DOI', relatedIdentifier: '10.1234/version' },
          { relationType: 'IsSupplementedBy', relatedIdentifierType: 'DOI', relatedIdentifier: '10.1234/supplement' },
          { relationType: 'IsCorrectedBy', relatedIdentifierType: 'DOI', relatedIdentifier: '10.1234/correction' },
        ],
      },
    }],
  }
  const { observations } = normalizePayload({ adapter: 'datacite', sourceId: 'datacite', observedAt: OBSERVED, bytes: jsonPayload(payload), synthetic: false })
  assert.deepEqual(observations[0].relations.map((item) => item.type), ['has-version', 'is-corrected-by', 'is-supplemented-by'])
})

test('provider ORCID variants normalize once to checksum-valid canonical URLs', () => {
  const dataCitePayload = {
    links: { next: null },
    data: [{
      id: '10.1234/orcid.variants',
      attributes: {
        doi: '10.1234/orcid.variants', created: '2026-08-19T00:00:00Z', updated: '2026-08-20T00:00:00Z',
        titles: [{ title: 'Agent security ORCID variants' }], types: { resourceTypeGeneral: 'Dataset' }, subjects: [], relatedIdentifiers: [],
        creators: [
          { name: 'Bare', nameIdentifiers: [{ nameIdentifierScheme: 'ORCID', nameIdentifier: '0000-0002-1825-0097' }] },
          { name: 'HTTP', nameIdentifiers: [{ nameIdentifierScheme: 'ORCID', nameIdentifier: 'http://orcid.org/0000-0002-1825-0097' }] },
          { name: 'HTTPS', nameIdentifiers: [{ nameIdentifierScheme: 'ORCID', nameIdentifier: 'https://orcid.org/0000-0002-1825-0097' }] },
          { name: 'Lowercase X', nameIdentifiers: [{ nameIdentifierScheme: 'ORCID', nameIdentifier: '0000-0000-0000-001x' }] },
          { name: 'Trailing slash', nameIdentifiers: [{ nameIdentifierScheme: 'ORCID', nameIdentifier: 'https://orcid.org/0000-0002-1825-0097/' }] },
          { name: 'Bad checksum', nameIdentifiers: [{ nameIdentifierScheme: 'ORCID', nameIdentifier: '0000-0002-1825-0098' }] },
          { name: 'Path injection', nameIdentifiers: [{ nameIdentifierScheme: 'ORCID', nameIdentifier: 'https://orcid.org/0000-0002-1825-0097/evil?x=1' }] },
        ],
      },
    }],
  }
  const dataCite = normalizePayload({ adapter: 'datacite', sourceId: 'datacite', observedAt: OBSERVED, bytes: jsonPayload(dataCitePayload), synthetic: false }).observations[0]
  assert.deepEqual(dataCite.authors.map((author) => author.orcid), [
    'https://orcid.org/0000-0002-1825-0097',
    'https://orcid.org/0000-0002-1825-0097',
    'https://orcid.org/0000-0002-1825-0097',
    'https://orcid.org/0000-0000-0000-001X',
    null,
    null,
    null,
  ])

  const crossrefPayload = { message: { items: [crossrefItem({ author: [{ given: 'Crossref', family: 'Author', ORCID: 'http://orcid.org/0000-0002-1825-0097' }] })], 'next-cursor': null } }
  const crossref = normalizePayload({ adapter: 'crossref', sourceId: 'crossref', observedAt: OBSERVED, bytes: jsonPayload(crossrefPayload), synthetic: false }).observations[0]
  assert.equal(crossref.authors[0].orcid, 'https://orcid.org/0000-0002-1825-0097')

  const openAlexPayload = { results: [{ id: 'https://openalex.org/W1', title: 'Mechanistic interpretability ORCID', type: 'article', authorships: [{ author: { display_name: 'OpenAlex Author', orcid: 'https://orcid.org/0000-0002-1825-0097' } }], topics: [] }], meta: { next_cursor: null } }
  const openalex = normalizePayload({ adapter: 'openalex', sourceId: 'openalex', observedAt: OBSERVED, bytes: jsonPayload(openAlexPayload), synthetic: false }).observations[0]
  assert.equal(openalex.authors[0].orcid, 'https://orcid.org/0000-0002-1825-0097')

  const registry = loadSchemaRegistry()
  for (const item of [dataCite, crossref, openalex]) assert.deepEqual(validateWithSchema(item, 'observation.schema.json', registry), [])
})

test('invalid calendar dates are not normalized and arXiv requires an identifier', () => {
  const payload = { message: { items: [crossrefItem({ published: { 'date-parts': [[2026, 2, 31]] } })], 'next-cursor': null } }
  const { observations } = normalizePayload({ adapter: 'crossref', sourceId: 'crossref', observedAt: OBSERVED, bytes: jsonPayload(payload), synthetic: false })
  assert.equal(observations[0].publishedOn, null)
  const missingId = Buffer.from('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Mechanistic interpretability</title></entry></feed>')
  assert.throws(() => normalizePayload({ adapter: 'arxiv', sourceId: 'arxiv', observedAt: OBSERVED, bytes: missingId, synthetic: false }), /lacks an identifier/u)
})

test('PubMed and Europe PMC do not infer peer review from indexing', () => {
  const snapshot = buildSnapshot({ includeFixtures: true, includeCaptures: false })
  for (const sourceId of ['pubmed-pmc', 'europe-pmc']) {
    assert.ok(snapshot.observations.filter((item) => item.sourceId === sourceId).every((item) => item.reviewState !== 'peer-reviewed'))
  }
})
