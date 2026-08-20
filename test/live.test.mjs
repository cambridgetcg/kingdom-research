import assert from 'node:assert/strict'
import test from 'node:test'

import { runCli } from '../src/cli.mjs'
import { readJson, ROOT } from '../src/io.mjs'
import { buildLiveRequest, LIVE_POLICIES, PollError, pollSource } from '../src/live.mjs'
import { join } from 'node:path'

const manifests = {
  sources: readJson(join(ROOT, 'sources', 'manifest.json')),
  watchlists: readJson(join(ROOT, 'watchlists', 'manifest.json')),
}
const source = (id) => manifests.sources.sources.find((item) => item.id === id)
const watchlist = (id = 'interpretable-reasoning') => manifests.watchlists.watchlists.find((item) => item.id === id)
const WATERMARK = '2026-08-19T00:00:00Z'
const OBSERVED = new Date('2026-08-20T15:00:00Z')

function responseJson(value, contentType = 'application/json') {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': contentType } })
}

function crossrefRecord(index, indexed = `2026-08-20T0${index}:00:00Z`) {
  return {
    DOI: `10.1234/live.${index}`,
    URL: `https://doi.org/10.1234/live.${index}`,
    title: [`Mechanistic interpretability live record ${index}`],
    author: [],
    published: { 'date-parts': [[2026, 8, 20]] },
    created: { 'date-time': '2026-08-19T01:00:00Z' },
    indexed: { 'date-time': indexed },
    type: 'journal-article',
  }
}

test('provider request shapes use exact reviewed terms and current bounded parameters', () => {
  const wl = watchlist()
  const common = { watchlist: wl, watermark: WATERMARK, items: 100, mailto: 'operator@example.org' }

  const crossref = buildLiveRequest({ sourceId: 'crossref', cursor: null, apiKey: null, ...common })
  assert.equal(crossref.url.protocol, 'https:')
  assert.equal(crossref.url.hostname, 'api.crossref.org')
  assert.equal(crossref.url.searchParams.get('filter'), 'from-index-date:2026-08-19T00:00:00')
  assert.equal(crossref.url.searchParams.get('cursor'), '*')
  const select = crossref.url.searchParams.get('select').split(',')
  assert.equal(select.includes('subtype'), false)
  assert.equal(select.includes('language'), false)
  assert.ok(wl.keywords.every((term) => crossref.url.searchParams.get('query.bibliographic').includes(`"${term}"`)))

  const integrity = buildLiveRequest({ sourceId: 'crossref-integrity', cursor: null, apiKey: null, ...common })
  assert.match(integrity.url.searchParams.get('filter'), /from-index-date:2026-08-19T00:00:00,has-update:true/u)

  const datacite = buildLiveRequest({ sourceId: 'datacite', cursor: null, apiKey: null, ...common })
  assert.equal(datacite.url.searchParams.get('page[cursor]'), '1')
  assert.match(datacite.url.searchParams.get('query'), /created:\[2026-08-19T00:00:00Z TO \*\]/u)
  assert.ok(wl.keywords.every((term) => datacite.url.searchParams.get('query').includes(`"${term}"`)))
  assert.equal(datacite.url.searchParams.has('sort'), false)

  const openalex = buildLiveRequest({ sourceId: 'openalex', cursor: null, apiKey: null, ...common })
  assert.ok(wl.keywords.every((term) => openalex.url.searchParams.get('search').includes(`"${term}"`)))
  assert.equal(openalex.url.searchParams.get('search').split(' OR ').length, wl.keywords.length)
  assert.equal(openalex.url.searchParams.get('search').includes('|'), false)
  assert.equal(openalex.url.searchParams.get('filter'), 'from_publication_date:2026-08-19')
  assert.equal(openalex.url.searchParams.get('filter').includes('from_updated_date'), false)
  assert.equal(openalex.url.searchParams.get('filter').includes('from_created_date'), false)
  assert.equal(openalex.url.searchParams.get('select').split(',').includes('version'), false)
  assert.equal(openalex.url.searchParams.has('api_key'), false)
  assert.equal(openalex.url.searchParams.get('per_page'), '100')

  const epmc = buildLiveRequest({ sourceId: 'europe-pmc', cursor: null, apiKey: null, ...common })
  assert.equal(epmc.url.searchParams.get('resultType'), 'core')
  assert.match(epmc.url.searchParams.get('query'), /UPDATE_DATE:\[2026-08-19 TO 3000-12-31\]/u)
  assert.ok(wl.keywords.every((term) => epmc.url.searchParams.get('query').includes(`"${term}"`)))

  const arxiv = buildLiveRequest({ sourceId: 'arxiv', cursor: null, apiKey: null, ...common })
  assert.equal(arxiv.url.href.startsWith('https://export.arxiv.org/api/query?'), true)
  assert.equal(arxiv.url.searchParams.get('max_results'), '100')
  assert.match(arxiv.url.searchParams.get('search_query'), /submittedDate:\[202608190000 TO 300001010000\]/u)
  assert.ok(wl.keywords.every((term) => arxiv.url.searchParams.get('search_query').includes(`all:"${term}"`)))

  assert.equal(LIVE_POLICIES['clinicaltrials-gov'], undefined)
  assert.equal(LIVE_POLICIES['biorxiv-medrxiv'], undefined)
  assert.equal(LIVE_POLICIES['pubmed-pmc'], undefined)
  assert.throws(() => buildLiveRequest({ sourceId: 'clinicaltrials-gov', cursor: null, apiKey: null, ...common }), /no live polling policy/u)
})

test('poll is HTTPS allowlisted, redirect-closed, identified, and metadata-only', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url, options }
    return new Response('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><totalResults>0</totalResults><startIndex>0</startIndex></feed>', {
      status: 200,
      headers: { 'content-type': 'application/atom+xml' },
    })
  }
  const result = await pollSource({ source: source('arxiv'), watchlist: watchlist(), watermark: WATERMARK, mailto: 'operator@example.org', fetchImpl, now: () => OBSERVED })
  assert.equal(seen.url.protocol, 'https:')
  assert.equal(seen.url.hostname, 'export.arxiv.org')
  assert.equal(seen.options.redirect, 'error')
  assert.match(seen.options.headers['user-agent'], /mailto:operator@example.org/u)
  assert.equal(result.effects.networkRequests, 1)
  assert.equal(result.effects.persistentWrites, 0)
  assert.equal(result.effects.fullTextRequests, 0)
  assert.equal(result.effects.artifactExecutions, 0)
})

test('response Content-Type is enforced before parsing', async () => {
  await assert.rejects(
    pollSource({ source: source('crossref'), watchlist: watchlist(), watermark: WATERMARK, mailto: 'operator@example.org', fetchImpl: async () => responseJson({}, 'text/html'), now: () => OBSERVED }),
    (error) => error instanceof PollError && error.code === 'content-type',
  )
})

test('non-success and declared or streamed oversized responses are rejected', async () => {
  const base = { source: source('crossref'), watchlist: watchlist(), watermark: WATERMARK, mailto: 'operator@example.org', now: () => OBSERVED }
  await assert.rejects(
    pollSource({ ...base, fetchImpl: async () => new Response('{"message":"bad query"}', { status: 400, headers: { 'content-type': 'application/json' } }) }),
    (error) => error instanceof PollError && error.code === 'http-status',
  )
  await assert.rejects(
    pollSource({ ...base, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '1048577' } }) }),
    (error) => error instanceof PollError && error.code === 'response-size',
  )
  const oversized = new Uint8Array(1024 * 1024 + 1)
  await assert.rejects(
    pollSource({ ...base, fetchImpl: async () => new Response(oversized, { status: 200, headers: { 'content-type': 'application/json' } }) }),
    (error) => error instanceof PollError && error.code === 'response-size',
  )
})

test('redirect responses are closed and transport errors never disclose an API key', async () => {
  let redirectMode
  await assert.rejects(
    pollSource({
      source: source('crossref'), watchlist: watchlist(), watermark: WATERMARK, mailto: 'operator@example.org', now: () => OBSERVED,
      fetchImpl: async (_url, options) => {
        redirectMode = options.redirect
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
      },
    }),
    (error) => error instanceof PollError && error.code === 'http-status',
  )
  assert.equal(redirectMode, 'error')

  const secret = 'openalex-secret-value-123'
  let failure
  try {
    await pollSource({
      source: source('openalex'), watchlist: watchlist(), watermark: WATERMARK, mailto: 'operator@example.org', apiKey: secret, now: () => OBSERVED,
      fetchImpl: async () => { throw new Error(`failed request containing ${secret}`) },
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof PollError)
  assert.equal(failure.code, 'transport')
  assert.equal(failure.message.includes(secret), false)
})

test('request/body timeout and total budget around arXiv sleep fail closed', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback)
    return 1
  }
  globalThis.clearTimeout = () => {}
  try {
    await assert.rejects(
      pollSource({
        source: source('crossref'), watchlist: watchlist(), watermark: WATERMARK, mailto: 'operator@example.org', now: () => OBSERVED,
        fetchImpl: async () => new Promise(() => {}),
      }),
      (error) => error instanceof PollError && error.code === 'request-timeout',
    )
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }

  let clock = Date.parse('2026-08-20T15:00:00Z')
  const arxivPage = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><totalResults>2</totalResults><startIndex>0</startIndex><entry><id>https://arxiv.org/abs/2608.00001</id><title>Mechanistic interpretability</title><published>2026-08-20T10:00:00Z</published><updated>2026-08-20T10:00:00Z</updated><author><name>Example A</name></author></entry></feed>'
  await assert.rejects(
    pollSource({
      source: source('arxiv'), watchlist: watchlist(), watermark: WATERMARK, pages: 2, items: 1,
      mailto: 'operator@example.org', now: () => new Date(clock),
      fetchImpl: async () => {
        clock += 23_000
        return new Response(arxivPage, { status: 200, headers: { 'content-type': 'application/atom+xml' } })
      },
      sleep: async () => { throw new Error('sleep must not begin after total budget is insufficient') },
    }),
    (error) => error instanceof PollError && error.code === 'total-timeout',
  )
})

test('provider over-return is rejected before local watchlist filtering', async () => {
  const payload = { message: { items: [crossrefRecord(1), { ...crossrefRecord(2), title: ['Unrelated record'] }], 'next-cursor': null } }
  await assert.rejects(
    pollSource({ source: source('crossref'), watchlist: watchlist(), watermark: WATERMARK, items: 1, mailto: 'operator@example.org', fetchImpl: async () => responseJson(payload), now: () => OBSERVED }),
    (error) => error instanceof PollError && error.code === 'upstream-item-limit',
  )
})

test('bound continuation carries high water across a scan longer than one invocation', async () => {
  const seenCursors = []
  let page = 0
  const firstFetch = async (url) => {
    seenCursors.push(url.searchParams.get('cursor'))
    page += 1
    return responseJson({ message: { items: [crossrefRecord(page)], 'next-cursor': `provider-${page}` } })
  }
  const first = await pollSource({
    source: source('crossref'), watchlist: watchlist(), watermark: WATERMARK,
    items: 1, pages: 3, mailto: 'operator@example.org', fetchImpl: firstFetch, now: () => OBSERVED,
  })
  assert.deepEqual(seenCursors, ['*', 'provider-1', 'provider-2'])
  assert.match(first.nextCursor, /^kr1\./u)
  assert.equal(first.watermarkAfter, WATERMARK)

  let resumedCursor
  const second = await pollSource({
    source: source('crossref'), watchlist: watchlist(), watermark: WATERMARK, cursor: first.nextCursor,
    items: 1, pages: 1, mailto: 'operator@example.org', now: () => OBSERVED,
    fetchImpl: async (url) => {
      resumedCursor = url.searchParams.get('cursor')
      return responseJson({ message: { items: [], 'next-cursor': 'provider-still-present' } })
    },
  })
  assert.equal(resumedCursor, 'provider-3')
  assert.equal(second.nextCursor, null)
  assert.equal(second.watermarkAfter, '2026-08-20T03:00:00Z')
  assert.equal(second.queryProvenance.cursorSupplied, true)
  assert.match(second.queryProvenance.cursorReceipt, /^sha256:/u)

  await assert.rejects(
    pollSource({ source: source('crossref'), watchlist: watchlist('agent-security'), watermark: WATERMARK, cursor: first.nextCursor, items: 1, pages: 1, mailto: 'operator@example.org', fetchImpl: async () => responseJson({}), now: () => OBSERVED }),
    (error) => error instanceof PollError && error.code === 'cursor-binding',
  )
  await assert.rejects(
    pollSource({ source: source('crossref'), watchlist: watchlist(), watermark: WATERMARK, cursor: 'provider-raw-cursor', items: 1, pages: 1, mailto: 'operator@example.org', fetchImpl: async () => responseJson({}), now: () => OBSERVED }),
    (error) => error instanceof PollError && error.code === 'invalid-cursor',
  )
})

test('DataCite returned cursor is bound and resumes only through the continuation token', async () => {
  let firstCursor
  const attributes = {
    doi: '10.1234/datacite.live', url: 'https://example.org/dataset', titles: [{ title: 'Agent security dataset' }],
    creators: [], published: '2026-08-20', created: '2026-08-20T08:00:00Z', updated: '2026-08-20T09:00:00Z',
    types: { resourceTypeGeneral: 'Dataset' }, subjects: [{ subject: 'agent security' }], relatedIdentifiers: [], rightsList: [],
  }
  const first = await pollSource({
    source: source('datacite'), watchlist: watchlist('agent-security'), watermark: WATERMARK, items: 1, mailto: 'operator@example.org', now: () => OBSERVED,
    fetchImpl: async (url) => {
      firstCursor = url.searchParams.get('page[cursor]')
      return responseJson({ data: [{ id: attributes.doi, attributes }], links: { next: 'https://api.datacite.org/dois?page%5Bcursor%5D=provider-next' } })
    },
  })
  assert.equal(firstCursor, '1')
  assert.match(first.nextCursor, /^kr1\./u)
  assert.equal(first.watermarkAfter, WATERMARK)

  let resumed
  const second = await pollSource({
    source: source('datacite'), watchlist: watchlist('agent-security'), watermark: WATERMARK, cursor: first.nextCursor,
    items: 1, mailto: 'operator@example.org', now: () => OBSERVED,
    fetchImpl: async (url) => {
      resumed = url.searchParams.get('page[cursor]')
      return responseJson({ data: [], links: { next: null } })
    },
  })
  assert.equal(resumed, 'provider-next')
  assert.equal(second.nextCursor, null)
  assert.equal(second.watermarkAfter, '2026-08-20T08:00:00Z')
})

test('strict provider-shaped fakes reject the known malformed parameter regressions', async () => {
  const wl = watchlist()
  const common = { watchlist: wl, watermark: WATERMARK, items: 1, mailto: 'operator@example.org', now: () => OBSERVED }
  await pollSource({
    source: source('crossref'), ...common,
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('filter').endsWith('Z'), false)
      assert.equal(url.searchParams.get('select').includes('subtype'), false)
      assert.equal(url.searchParams.get('select').includes('language'), false)
      return responseJson({ message: { items: [], 'next-cursor': 'always-present' } })
    },
  })
  await pollSource({
    source: source('openalex'), ...common,
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('search').includes('|'), false)
      assert.equal(url.searchParams.get('select').split(',').includes('version'), false)
      return responseJson({ results: [], meta: { next_cursor: null } })
    },
  })
  await pollSource({
    source: source('datacite'), ...common,
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('page[cursor]'), '1')
      return responseJson({ data: [], links: { next: null } })
    },
  })
})

test('Europe PMC core revision metadata retains an older publication updated in-window and omits abstract', async () => {
  const payload = {
    nextCursorMark: null,
    resultList: { result: [{
      id: '123', source: 'MED', pmid: '123', title: 'Information flow control for agent security',
      authorString: 'Example A', firstPublicationDate: '2020-01-01', dateOfCreation: '2020-01-02', dateOfRevision: '2026-08-20',
      pubTypeList: { pubType: ['research article'] }, abstractText: 'This field must not survive normalization.',
    }] },
  }
  const result = await pollSource({ source: source('europe-pmc'), watchlist: watchlist('agent-security'), watermark: WATERMARK, mailto: 'operator@example.org', fetchImpl: async () => responseJson(payload), now: () => OBSERVED })
  assert.equal(result.observations.length, 1)
  assert.equal(result.observations[0].upstreamUpdatedAt, '2026-08-20T00:00:00Z')
  assert.equal(result.observations[0].publishedOn, '2020-01-01')
  assert.equal(Object.hasOwn(result.observations[0], 'abstractText'), false)
})

test('future issue dates remain metadata but never advance a watermark past observation time', async () => {
  const payload = {
    meta: { next_cursor: null },
    results: [{
      id: 'https://openalex.org/W123', title: 'Mechanistic interpretability in future issue',
      publication_date: '2027-01-01', created_date: '2026-08-19', updated_date: '2026-08-20T10:00:00Z',
      type: 'article', ids: { openalex: 'https://openalex.org/W123' }, authorships: [], topics: [{ display_name: 'mechanistic interpretability' }],
      primary_location: { landing_page_url: 'https://example.org/work' },
    }],
  }
  const result = await pollSource({ source: source('openalex'), watchlist: watchlist(), watermark: WATERMARK, mailto: 'operator@example.org', fetchImpl: async () => responseJson(payload), now: () => OBSERVED })
  assert.equal(result.observations[0].publishedOn, '2027-01-01')
  assert.equal(result.watermarkAfter, WATERMARK)
})

test('CLI exposes no raw URL or free-form query broadening', async () => {
  await assert.rejects(runCli(['poll', '--url', 'https://evil.example', '--query', '*']), /unknown option --url/u)
})
