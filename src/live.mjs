import { setTimeout as delay } from 'node:timers/promises'

import { normalizePayload } from './adapters.mjs'
import { canonicalJson, parseJsonBytes, sha256Bytes, sha256Json } from './io.mjs'
import { loadSchemaRegistry, validateWithSchema } from './schema-validator.mjs'

export const POLL_LIMITS = Object.freeze({
  maximumPages: 3,
  maximumItemsPerPage: 100,
  maximumBytesPerPage: 1024 * 1024,
  requestMilliseconds: 10_000,
  totalMilliseconds: 25_000,
})

export const LIVE_POLICIES = Object.freeze({
  arxiv: {
    adapter: 'arxiv', host: 'export.arxiv.org', path: '/api/query', format: 'xml',
    watermarkKind: 'created-time', queryMode: 'reviewed-terms-submission-discovery', minimumIntervalMilliseconds: 3_000,
  },
  crossref: {
    adapter: 'crossref', host: 'api.crossref.org', path: '/works', format: 'json',
    watermarkKind: 'index-time', queryMode: 'reviewed-terms-index-delta', minimumIntervalMilliseconds: 0,
  },
  'crossref-integrity': {
    adapter: 'crossref-updates', host: 'api.crossref.org', path: '/works', format: 'json',
    watermarkKind: 'index-time', queryMode: 'reviewed-terms-index-delta', minimumIntervalMilliseconds: 0,
  },
  datacite: {
    adapter: 'datacite', host: 'api.datacite.org', path: '/dois', format: 'json',
    watermarkKind: 'created-time', queryMode: 'reviewed-terms-created-delta', minimumIntervalMilliseconds: 0,
  },
  'europe-pmc': {
    adapter: 'europe-pmc', host: 'www.ebi.ac.uk', path: '/europepmc/webservices/rest/search', format: 'json',
    watermarkKind: 'updated-time', queryMode: 'reviewed-terms-update-delta', minimumIntervalMilliseconds: 0,
  },
  openalex: {
    adapter: 'openalex', host: 'api.openalex.org', path: '/works', format: 'json',
    watermarkKind: 'publication-date', queryMode: 'reviewed-terms-publication-discovery', minimumIntervalMilliseconds: 0,
  },
})

export class PollError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PollError'
    this.code = code
  }
}

function exactInstant(value, label = 'watermark') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    throw new PollError('invalid-time', `${label} must be an ISO UTC instant at whole-second precision`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace(/\.000Z$/u, 'Z') !== value) {
    throw new PollError('invalid-time', `${label} is not a real UTC instant`)
  }
  return value
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PollError('invalid-limit', `${label} must be an integer in ${minimum}..${maximum}`)
  }
  return value
}

function contactAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new PollError('invalid-contact', 'poll requires a valid contact email address')
  }
  return value
}

function watchlistTerms(watchlist) {
  if (watchlist?.schema !== 'kingdom.research-watchlist/0.1' || !Array.isArray(watchlist.keywords)) {
    throw new PollError('invalid-watchlist', 'poll requires one checked-in watchlist')
  }
  const terms = [...watchlist.keywords]
  if (terms.length < 3 || terms.length > 32 || terms.some((term) => typeof term !== 'string' || term.length < 2 || term.length > 96)) {
    throw new PollError('invalid-watchlist', 'watchlist terms are outside bounded shape')
  }
  return terms
}

function cursorReceipt(cursor) {
  return cursor === null ? null : sha256Bytes(Buffer.from(cursor))
}

function continuationBinding({ sourceId, watchlist, watermark, items, queryMode }) {
  return {
    sourceId,
    watchlistId: watchlist.id,
    watermark,
    items,
    queryMode,
    termsReceipt: sha256Json(watchlistTerms(watchlist)),
  }
}

function encodeContinuation(binding, providerCursor, highWatermark) {
  const body = { v: 1, binding, providerCursor, highWatermark }
  const token = `kr1.${Buffer.from(canonicalJson(body)).toString('base64url')}`
  if (token.length > 4096) throw new PollError('cursor-size', 'bound continuation exceeds 4096 characters')
  return token
}

function decodeContinuation(token, expectedBinding) {
  if (typeof token !== 'string' || !token.startsWith('kr1.') || token.length > 4096) {
    throw new PollError('invalid-cursor', 'continuation must be a KINGDOM-bound cursor returned by a prior poll')
  }
  let value
  try {
    const encoded = token.slice(4)
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('invalid base64url')
    value = parseJsonBytes(Buffer.from(encoded, 'base64url'), 'continuation cursor')
  } catch {
    throw new PollError('invalid-cursor', 'continuation cursor is malformed')
  }
  const keys = Object.keys(value).sort()
  if (canonicalJson(keys) !== canonicalJson(['binding', 'highWatermark', 'providerCursor', 'v'])) {
    throw new PollError('invalid-cursor', 'continuation cursor has an unexpected shape')
  }
  if (value.v !== 1 || canonicalJson(value.binding) !== canonicalJson(expectedBinding)) {
    throw new PollError('cursor-binding', 'continuation cursor does not match this source, watchlist, watermark, item bound, or query mode')
  }
  if (typeof value.providerCursor !== 'string' || value.providerCursor.length < 1 || value.providerCursor.length > 3072) {
    throw new PollError('invalid-cursor', 'provider cursor is outside its bound')
  }
  exactInstant(value.highWatermark, 'continuation high watermark')
  if (value.highWatermark < expectedBinding.watermark) throw new PollError('invalid-cursor', 'continuation high watermark moved backwards')
  return value
}

export function inspectBoundContinuation({ token, sourceId, watchlist, watermark, items, queryMode }) {
  const binding = continuationBinding({ sourceId, watchlist, watermark, items, queryMode })
  return structuredClone(decodeContinuation(token, binding))
}

function quotedTerms(terms) {
  return terms.map((term) => `"${term.replaceAll('"', '')}"`).join(' OR ')
}

function datePart(watermark) {
  return watermark.slice(0, 10)
}

function buildParameters(sourceId, terms, watermark, cursor, items, mailto, apiKey) {
  const phraseQuery = quotedTerms(terms)
  if (sourceId === 'crossref' || sourceId === 'crossref-integrity') {
    const crossrefWatermark = watermark.replace(/Z$/u, '')
    const params = new URLSearchParams({
      rows: String(items),
      cursor: cursor ?? '*',
      mailto,
      'query.bibliographic': phraseQuery,
      filter: sourceId === 'crossref'
        ? `from-index-date:${crossrefWatermark}`
        : `from-index-date:${crossrefWatermark},has-update:true`,
      select: 'DOI,URL,title,author,published,indexed,created,type,subject,relation,update-to,license',
    })
    return params
  }
  if (sourceId === 'datacite') {
    const params = new URLSearchParams({
      'page[size]': String(items),
      'page[cursor]': cursor ?? '1',
      query: `titles.title:(${phraseQuery}) AND created:[${watermark} TO *]`,
    })
    return params
  }
  if (sourceId === 'openalex') {
    const params = new URLSearchParams({
      search: phraseQuery,
      filter: `from_publication_date:${datePart(watermark)}`,
      per_page: String(items),
      cursor: cursor ?? '*',
      mailto,
      select: 'id,doi,title,publication_date,created_date,updated_date,type,language,ids,authorships,topics,primary_location,is_retracted',
    })
    if (apiKey !== null) params.set('api_key', apiKey)
    return params
  }
  if (sourceId === 'arxiv') {
    const submittedFrom = watermark.replace(/[-:TZ]/gu, '').slice(0, 12)
    return new URLSearchParams({
      search_query: `submittedDate:[${submittedFrom} TO 300001010000] AND (${terms.map((term) => `all:"${term.replaceAll('"', '')}"`).join(' OR ')})`,
      start: cursor ?? '0',
      max_results: String(items),
      sortBy: 'submittedDate',
      sortOrder: 'ascending',
    })
  }
  if (sourceId === 'europe-pmc') {
    const params = new URLSearchParams({
      query: `(TITLE_ABS:(${phraseQuery})) AND UPDATE_DATE:[${datePart(watermark)} TO 3000-12-31]`,
      format: 'json',
      resultType: 'core',
      pageSize: String(items),
      cursorMark: cursor ?? '*',
      email: mailto,
    })
    return params
  }
  throw new PollError('unsupported-source', 'source has no live polling policy')
}

export function buildLiveRequest({ sourceId, watchlist, watermark, cursor = null, items = 25, mailto, apiKey = null }) {
  const policy = LIVE_POLICIES[sourceId]
  if (policy === undefined) throw new PollError('unsupported-source', 'source has no live polling policy')
  const checkedWatermark = exactInstant(watermark)
  const checkedItems = boundedInteger(items, 1, POLL_LIMITS.maximumItemsPerPage, 'items')
  const checkedMailto = contactAddress(mailto)
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 4096)) {
    throw new PollError('invalid-cursor', 'cursor is outside 1..4096 characters')
  }
  if (apiKey !== null && (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 512)) {
    throw new PollError('invalid-api-key', 'API key is outside its accepted bounds')
  }
  if (sourceId !== 'openalex' && apiKey !== null) throw new PollError('unexpected-api-key', 'only OpenAlex accepts an API key in this MVP')
  const terms = watchlistTerms(watchlist)
  const url = new URL(`https://${policy.host}${policy.path}`)
  url.search = buildParameters(sourceId, terms, checkedWatermark, cursor, checkedItems, checkedMailto, apiKey).toString()
  return {
    url,
    policy,
    terms,
    queryShape: {
      sourceId,
      watchlistId: watchlist.id,
      terms,
      watermark: checkedWatermark,
      itemsPerPage: checkedItems,
      cursorSupplied: cursor !== null,
      cursorReceipt: cursorReceipt(cursor),
      cursorProtocol: 'kingdom-bound-continuation-v1',
      queryMode: policy.queryMode,
    },
    headers: {
      accept: policy.format === 'json' ? 'application/json' : 'application/atom+xml, application/xml;q=0.9',
      'user-agent': `kingdom-research/${'0.1.0'} (metadata-only; mailto:${checkedMailto})`,
    },
  }
}

export function assertAllowedLiveUrl(url, policy) {
  if (!(url instanceof URL)
    || url.protocol !== 'https:'
    || url.hostname !== policy.host
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.pathname !== policy.path
    || url.href.length > 8192) {
    throw new PollError('url-policy', 'internally built request failed the exact HTTPS allowlist')
  }
}

async function responseBytes(response, maximum, format) {
  if (!response || typeof response.status !== 'number') throw new PollError('transport', 'transport returned no HTTP response')
  if (response.status < 200 || response.status > 299) throw new PollError('http-status', `upstream returned HTTP ${response.status}`)
  const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase()
  const accepted = format === 'json'
    ? contentType.includes('application/json') || contentType.includes('+json')
    : contentType.includes('application/atom+xml') || contentType.includes('application/xml') || contentType.includes('text/xml') || contentType.includes('+xml')
  if (!accepted) throw new PollError('content-type', 'upstream response has an unexpected media type')
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maximum) throw new PollError('response-size', 'declared response exceeds byte limit')
  const chunks = []
  let length = 0
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximum) {
        await reader.cancel()
        throw new PollError('response-size', 'response exceeds byte limit')
      }
      chunks.push(Buffer.from(value))
    }
  } else {
    const value = Buffer.from(await response.arrayBuffer())
    length = value.byteLength
    if (length > maximum) throw new PollError('response-size', 'response exceeds byte limit')
    chunks.push(value)
  }
  return Buffer.concat(chunks, length)
}

async function fetchPage(request, fetchImpl, remainingMilliseconds) {
  assertAllowedLiveUrl(request.url, request.policy)
  if (remainingMilliseconds <= 0) throw new PollError('total-timeout', 'poll exceeded its total time budget')
  const controller = new AbortController()
  const timeout = Math.min(POLL_LIMITS.requestMilliseconds, remainingMilliseconds)
  const totalLimited = remainingMilliseconds <= POLL_LIMITS.requestMilliseconds
  let rejectTimeout
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject })
  const timer = setTimeout(() => {
    rejectTimeout(new PollError(totalLimited ? 'total-timeout' : 'request-timeout', totalLimited ? 'poll exceeded its total time budget' : 'upstream request exceeded its time limit'))
    controller.abort()
  }, timeout)
  try {
    const response = await Promise.race([fetchImpl(request.url, {
      method: 'GET', headers: request.headers, redirect: 'error', signal: controller.signal,
    }), timeoutPromise])
    return await Promise.race([responseBytes(response, POLL_LIMITS.maximumBytesPerPage, request.policy.format), timeoutPromise])
  } catch (error) {
    if (error instanceof PollError) throw error
    if (error?.name === 'AbortError') throw new PollError('request-timeout', 'upstream request exceeded its time limit')
    throw new PollError('transport', 'bounded upstream request failed')
  } finally {
    clearTimeout(timer)
  }
}

function matchesWatchlist(observation, terms) {
  const haystack = `${observation.title}\n${observation.subjects.join('\n')}`.toLocaleLowerCase('en-US')
  return terms.some((term) => haystack.includes(term.toLocaleLowerCase('en-US')))
}

function watermarkCandidate(observation, kind) {
  if (kind === 'publication-date') return observation.publishedOn === null ? null : `${observation.publishedOn}T00:00:00Z`
  if (kind === 'created-time') return observation.upstreamCreatedAt
  return observation.upstreamUpdatedAt
}

async function boundedSleep(milliseconds, remainingMilliseconds, sleep) {
  if (milliseconds <= 0) return
  if (remainingMilliseconds <= milliseconds) throw new PollError('total-timeout', 'poll exceeded its total time budget')
  let rejectTimeout
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject })
  const timer = setTimeout(() => rejectTimeout(new PollError('total-timeout', 'poll exceeded its total time budget')), remainingMilliseconds)
  try { await Promise.race([sleep(milliseconds), timeoutPromise]) } finally { clearTimeout(timer) }
}

export async function pollSource({
  source,
  watchlist,
  watermark,
  cursor = null,
  pages = 1,
  items = 25,
  mailto,
  apiKey = null,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  sleep = delay,
}) {
  if (typeof fetchImpl !== 'function') throw new PollError('transport', 'fetch transport is unavailable')
  const checkedPages = boundedInteger(pages, 1, POLL_LIMITS.maximumPages, 'pages')
  const checkedItems = boundedInteger(items, 1, POLL_LIMITS.maximumItemsPerPage, 'items')
  const checkedWatermark = exactInstant(watermark)
  const startMilliseconds = now().getTime()
  let bytesReceived = 0
  let pagesFetched = 0
  let lastObservedAt = checkedWatermark
  const observations = []
  const terms = watchlistTerms(watchlist)
  const policy = LIVE_POLICIES[source.id]
  if (policy === undefined) throw new PollError('unsupported-source', 'source has no live polling policy')
  const binding = continuationBinding({ sourceId: source.id, watchlist, watermark: checkedWatermark, items: checkedItems, queryMode: policy.queryMode })
  const continuation = cursor === null ? null : decodeContinuation(cursor, binding)
  let nextProviderCursor = continuation?.providerCursor ?? null
  let highWatermark = continuation?.highWatermark ?? checkedWatermark
  const inputCursorReceipt = cursorReceipt(cursor)
  const queryShape = {
    sourceId: source.id,
    watchlistId: watchlist.id,
    terms,
    watermark: checkedWatermark,
    itemsPerPage: checkedItems,
    cursorSupplied: cursor !== null,
    cursorReceipt: inputCursorReceipt,
    cursorProtocol: 'kingdom-bound-continuation-v1',
    queryMode: policy.queryMode,
  }
  let networkRequests = 0
  const remaining = () => POLL_LIMITS.totalMilliseconds - (now().getTime() - startMilliseconds)

  for (let page = 0; page < checkedPages; page += 1) {
    if (remaining() <= 0) {
      throw new PollError('total-timeout', 'poll exceeded its total time budget')
    }
    if (page > 0 && policy.minimumIntervalMilliseconds > 0) await boundedSleep(policy.minimumIntervalMilliseconds, remaining(), sleep)
    const request = buildLiveRequest({ sourceId: source.id, watchlist, watermark: checkedWatermark, cursor: nextProviderCursor, items: checkedItems, mailto, apiKey })
    const bytes = await fetchPage(request, fetchImpl, remaining())
    networkRequests += 1
    if (remaining() <= 0) throw new PollError('total-timeout', 'poll exceeded its total time budget')
    const observedAt = exactInstant(now().toISOString().replace(/\.\d{3}Z$/u, 'Z'), 'observedAt')
    if (observedAt < checkedWatermark) throw new PollError('future-watermark', 'watermark is later than the observation clock')
    lastObservedAt = observedAt
    const normalized = normalizePayload({ adapter: policy.adapter, sourceId: source.id, observedAt, bytes, synthetic: false })
    if (normalized.rawItemCount > checkedItems) throw new PollError('upstream-item-limit', 'upstream returned more records than requested')
    for (const item of normalized.observations) {
      const maximumSourceTime = new Date(Date.parse(observedAt) + 5 * 60_000).toISOString().replace(/\.000Z$/u, 'Z')
      if ((item.upstreamCreatedAt !== null && item.upstreamCreatedAt > maximumSourceTime)
        || (item.upstreamUpdatedAt !== null && item.upstreamUpdatedAt > maximumSourceTime)) {
        throw new PollError('future-source-time', 'upstream record timestamp is later than the observation time')
      }
      const candidate = watermarkCandidate(item, policy.watermarkKind)
      if (candidate !== null && candidate <= observedAt && candidate > highWatermark) highWatermark = candidate
    }
    const pageObservations = normalized.observations
      .filter((item) => matchesWatchlist(item, terms))
      .filter((item) => {
        const candidate = watermarkCandidate(item, policy.watermarkKind)
        return candidate === null || candidate >= checkedWatermark
      })
      .slice(0, checkedItems)
    observations.push(...pageObservations)
    if (observations.length > checkedPages * checkedItems) throw new PollError('item-limit', 'poll exceeded its item limit')
    bytesReceived += bytes.byteLength
    pagesFetched += 1
    nextProviderCursor = normalized.nextCursor
    if ((source.id === 'crossref' || source.id === 'crossref-integrity') && normalized.rawItemCount < checkedItems) nextProviderCursor = null
    if (nextProviderCursor === null) break
  }

  const nextCursor = nextProviderCursor === null ? null : encodeContinuation(binding, nextProviderCursor, highWatermark)
  const watermarkAfter = nextCursor === null ? highWatermark : checkedWatermark
  if (watermarkAfter > lastObservedAt) throw new PollError('future-watermark', 'derived watermark is later than the poll observation')
  const result = {
    schema: 'kingdom.research-poll-result/0.1',
    sourceId: source.id,
    observedAt: lastObservedAt,
    watermarkKind: policy.watermarkKind,
    watermarkBefore: checkedWatermark,
    watermarkAfter,
    nextCursor,
    queryProvenance: {
      watchlistId: watchlist.id,
      terms,
      watermark: checkedWatermark,
      itemsPerPage: checkedItems,
      cursorSupplied: cursor !== null,
      cursorReceipt: inputCursorReceipt,
      cursorProtocol: 'kingdom-bound-continuation-v1',
      queryMode: policy.queryMode,
      queryReceipt: sha256Json(queryShape),
      callerSuppliedQuery: false,
      rawUrlAccepted: false,
    },
    limits: {
      pages: checkedPages,
      itemsPerPage: checkedItems,
      bytesPerPage: POLL_LIMITS.maximumBytesPerPage,
      requestMilliseconds: POLL_LIMITS.requestMilliseconds,
      totalMilliseconds: POLL_LIMITS.totalMilliseconds,
    },
    usage: { pagesFetched, itemsReceived: observations.length, bytesReceived },
    sourceRights: structuredClone(source.rights),
    sourceProcessing: {
      upstreamDataTimestamp: null,
      modificationDescription: 'Normalized selected metadata fields, identifiers, dates, relations, and status only; field names and ordering changed; full text and executable artifacts were omitted.',
    },
    observations,
    effects: { networkRequests, persistentWrites: 0, fullTextRequests: 0, artifactExecutions: 0 },
    nonClaims: { evaluated: false, adopted: false, useAuthorized: false, moduleCreated: false, guestAdmitted: false },
  }
  const issues = validateWithSchema(result, 'poll-result.schema.json', loadSchemaRegistry())
  if (issues.length > 0) throw new PollError('result-shape', `poll result failed its schema: ${issues.slice(0, 4).join('; ')}`)
  return result
}
