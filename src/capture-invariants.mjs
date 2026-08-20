import { canonicalJson, sha256Json } from './io.mjs'
import { inspectBoundContinuation, LIVE_POLICIES, POLL_LIMITS } from './live.mjs'

function exactInstant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    throw new TypeError(`${label} must be a whole-second UTC instant`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace(/\.000Z$/u, 'Z') !== value) {
    throw new TypeError(`${label} is not a real UTC instant`)
  }
  return value
}

function exactDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError(`${label} must be an ISO date`)
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new TypeError(`${label} is not a real calendar date`)
  }
  return value
}

export function pollEnvelopeInvariantIssues(envelope, { sources, watchlists }) {
  const issues = []
  const source = sources.sources.find((item) => item.id === envelope.sourceId)
  const watchlist = watchlists.watchlists.find((item) => item.id === envelope.queryProvenance?.watchlistId)
  const policy = LIVE_POLICIES[envelope.sourceId]
  if (source === undefined) issues.push('sourceId is not in the checked-in manifest')
  if (watchlist === undefined) issues.push('watchlistId is not in the checked-in manifest')
  if (policy === undefined) issues.push('source is not enabled for live polling in this release')

  try { exactInstant(envelope.observedAt, 'observedAt') } catch (error) { issues.push(error.message) }
  try { exactInstant(envelope.watermarkBefore, 'watermarkBefore') } catch (error) { issues.push(error.message) }
  try { exactInstant(envelope.watermarkAfter, 'watermarkAfter') } catch (error) { issues.push(error.message) }
  if (envelope.queryProvenance?.watermark !== envelope.watermarkBefore) issues.push('query watermark must equal watermarkBefore')
  if (envelope.watermarkBefore > envelope.observedAt) issues.push('watermarkBefore must not occur after observedAt')
  if (envelope.watermarkAfter > envelope.observedAt) issues.push('watermarkAfter must not occur after observedAt')
  if (envelope.watermarkAfter < envelope.watermarkBefore) issues.push('watermarkAfter must not move backwards')
  if (policy !== undefined && envelope.watermarkKind !== policy.watermarkKind) issues.push('watermarkKind differs from the enabled source policy')

  if (watchlist !== undefined && canonicalJson(envelope.queryProvenance?.terms) !== canonicalJson(watchlist.keywords)) {
    issues.push('query terms must exactly equal the checked-in reviewed watchlist terms')
  }
  if (policy !== undefined && envelope.queryProvenance?.queryMode !== policy.queryMode) issues.push('query mode differs from the enabled source policy')
  const queryShape = {
    sourceId: envelope.sourceId,
    watchlistId: envelope.queryProvenance?.watchlistId,
    terms: envelope.queryProvenance?.terms,
    watermark: envelope.watermarkBefore,
    itemsPerPage: envelope.queryProvenance?.itemsPerPage,
    cursorSupplied: envelope.queryProvenance?.cursorSupplied,
    cursorReceipt: envelope.queryProvenance?.cursorReceipt,
    cursorProtocol: envelope.queryProvenance?.cursorProtocol,
    queryMode: envelope.queryProvenance?.queryMode,
  }
  if (envelope.queryProvenance?.queryReceipt !== sha256Json(queryShape)) issues.push('query receipt does not bind the effective reviewed query shape')
  if (envelope.queryProvenance?.callerSuppliedQuery !== false || envelope.queryProvenance?.rawUrlAccepted !== false) issues.push('capture must not accept a caller query or raw URL')

  if (source !== undefined && canonicalJson(envelope.sourceRights) !== canonicalJson(source.rights)) issues.push('source rights must exactly match the checked-in attributed source statement')
  if (envelope.limits?.pages > POLL_LIMITS.maximumPages
    || envelope.limits?.itemsPerPage > POLL_LIMITS.maximumItemsPerPage
    || envelope.limits?.bytesPerPage > POLL_LIMITS.maximumBytesPerPage
    || envelope.limits?.requestMilliseconds > POLL_LIMITS.requestMilliseconds
    || envelope.limits?.totalMilliseconds > POLL_LIMITS.totalMilliseconds) issues.push('declared poll limits exceed the release ceilings')
  if (envelope.usage?.pagesFetched > envelope.limits?.pages) issues.push('pages fetched exceed the declared page limit')
  if (envelope.usage?.itemsReceived !== envelope.observations?.length) issues.push('itemsReceived must equal retained observation count')
  if (envelope.usage?.itemsReceived > envelope.usage?.pagesFetched * envelope.limits?.itemsPerPage) issues.push('retained items exceed the page/item product')
  if (envelope.usage?.bytesReceived > envelope.usage?.pagesFetched * envelope.limits?.bytesPerPage) issues.push('received bytes exceed the page/byte product')
  if (envelope.effects?.networkRequests !== envelope.usage?.pagesFetched || envelope.effects?.networkRequests < 1) issues.push('network request count must equal pages fetched and be positive')
  if (envelope.effects?.persistentWrites !== 0 || envelope.effects?.fullTextRequests !== 0 || envelope.effects?.artifactExecutions !== 0) issues.push('poll envelope must report no writes, full-text requests, or execution')
  if (envelope.sourceProcessing?.upstreamDataTimestamp !== null) issues.push('enabled 0.1 adapters do not claim a separate upstream processing timestamp')

  if (envelope.nextCursor !== null && envelope.watermarkAfter !== envelope.watermarkBefore) issues.push('a nonterminal cursor page must hold its starting watermark')
  if (envelope.queryProvenance?.cursorSupplied === (envelope.queryProvenance?.cursorReceipt === null)) issues.push('cursorReceipt must be present exactly when a continuation was supplied')
  if (envelope.nextCursor !== null && watchlist !== undefined && policy !== undefined) {
    try {
      const continuation = inspectBoundContinuation({
        token: envelope.nextCursor,
        sourceId: envelope.sourceId,
        watchlist,
        watermark: envelope.watermarkBefore,
        items: envelope.queryProvenance.itemsPerPage,
        queryMode: policy.queryMode,
      })
      if (continuation.highWatermark > envelope.observedAt) issues.push('continuation high watermark occurs after observedAt')
    } catch (error) {
      issues.push(`nextCursor is not a valid bound continuation: ${error.message}`)
    }
  }

  for (const observation of envelope.observations ?? []) {
    try { exactInstant(observation.observedAt, `observation ${observation.id ?? '?'} observedAt`) } catch (error) { issues.push(error.message) }
    if (observation.upstreamCreatedAt !== null) {
      try { exactInstant(observation.upstreamCreatedAt, `observation ${observation.id ?? '?'} created time`) } catch (error) { issues.push(error.message) }
    }
    if (observation.upstreamUpdatedAt !== null) {
      try { exactInstant(observation.upstreamUpdatedAt, `observation ${observation.id ?? '?'} updated time`) } catch (error) { issues.push(error.message) }
    }
    if (observation.publishedOn !== null) {
      try { exactDate(observation.publishedOn, `observation ${observation.id ?? '?'} publication date`) } catch (error) { issues.push(error.message) }
    }
    if (observation.sourceId !== envelope.sourceId) issues.push(`observation ${observation.id ?? '?'} has a different sourceId`)
    if (observation.synthetic !== false || observation.inert !== true) issues.push(`observation ${observation.id ?? '?'} must be non-synthetic and inert`)
    if (observation.observedAt > envelope.observedAt) issues.push(`observation ${observation.id ?? '?'} occurs after its envelope`)
    const maximumSourceTime = new Date(Date.parse(envelope.observedAt) + 5 * 60_000).toISOString().replace(/\.000Z$/u, 'Z')
    if (observation.upstreamCreatedAt !== null && observation.upstreamCreatedAt > maximumSourceTime) issues.push(`observation ${observation.id ?? '?'} has a future created time`)
    if (observation.upstreamUpdatedAt !== null && observation.upstreamUpdatedAt > maximumSourceTime) issues.push(`observation ${observation.id ?? '?'} has a future updated time`)
  }
  if (Object.values(envelope.nonClaims ?? {}).some((value) => value !== false)) issues.push('capture cannot claim evaluation, adoption, use, module creation, or guest admission')
  return issues
}
