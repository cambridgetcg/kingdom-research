import { parseJsonBytes, sha256Bytes } from './io.mjs'

export const ADAPTER_NAMES = Object.freeze([
  'arxiv',
  'biorxiv',
  'clinicaltrials-gov',
  'crossref',
  'crossref-updates',
  'datacite',
  'europe-pmc',
  'openalex',
  'pubmed',
])

const DOI_PREFIX = /^https?:\/\/(?:dx\.)?doi\.org\//i
const PMID_PREFIX = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i

function text(value, label, maximum = 1024) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length < 1 || [...normalized].length > maximum) {
    throw new RangeError(`${label} is outside 1..${maximum} characters`)
  }
  return normalized
}

function optionalText(value, label, maximum = 1024) {
  if (value === undefined || value === null || value === '') return null
  return text(String(value), label, maximum)
}

function httpsUrl(value, fallback, label = 'canonical URL') {
  const candidate = optionalText(value, label, 2048) ?? fallback
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === '') return parsed.href
  } catch {
    // A depositor-controlled URL is inert input. Fall through to the local safe link.
  }
  const safe = new URL(fallback)
  if (safe.protocol !== 'https:' || safe.username !== '' || safe.password !== '' || safe.hash !== '') {
    throw new TypeError(`${label} fallback must be a fragment-free HTTPS URL`)
  }
  return safe.href
}

function isoDate(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/u)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null
  return `${match[1]}-${match[2]}-${match[3]}`
}

function crossrefDate(value) {
  const parts = value?.['date-parts']?.[0]
  if (!Array.isArray(parts) || parts.length < 1) return null
  const [year, month = 1, day = 1] = parts
  if (![year, month, day].every(Number.isInteger)) return null
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function instant(value) {
  if (typeof value !== 'string' || value === '') return null
  const asDate = isoDate(value)
  if (asDate === null) return null
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value}T00:00:00Z`
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

function language(value) {
  const candidate = Array.isArray(value) ? value[0] : value
  if (candidate === 'eng') return 'en'
  if (typeof candidate !== 'string') return null
  const lowered = candidate.toLowerCase().slice(0, 3)
  return /^[a-z]{2,3}$/u.test(lowered) ? lowered : null
}

function identifier(scheme, raw) {
  if (raw === undefined || raw === null || raw === '') return null
  let value = text(String(raw), `${scheme} identifier`, 512)
  if (scheme === 'doi' || scheme === 'datacite-doi') value = value.replace(DOI_PREFIX, '').toLowerCase()
  if (scheme === 'pmid') value = value.replace(PMID_PREFIX, '').replace(/\/$/u, '')
  if (scheme === 'openalex') value = value.replace(/^https:\/\/openalex\.org\//iu, '')
  if (scheme === 'nct') value = value.toUpperCase()
  return { scheme, value }
}

function identifiers(values) {
  const result = []
  const seen = new Set()
  for (const item of values) {
    if (item === null) continue
    const key = `${item.scheme}:${item.value}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result.sort((left, right) => `${left.scheme}:${left.value}`.localeCompare(`${right.scheme}:${right.value}`))
}

export function normalizeOrcid(value) {
  if (value === undefined || value === null || value === '') return null
  const candidate = String(value).trim()
  const match = candidate.match(/^(?:https?:\/\/orcid\.org\/)?([0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9x])$/iu)
  if (match === null) return null
  const compact = match[1].replaceAll('-', '').toUpperCase()
  let total = 0
  for (const digit of compact.slice(0, 15)) total = (total + Number(digit)) * 2
  const result = (12 - (total % 11)) % 11
  const expected = result === 10 ? 'X' : String(result)
  if (compact.at(-1) !== expected) return null
  const canonical = compact.replace(/^(.{4})(.{4})(.{4})(.{4})$/u, '$1-$2-$3-$4')
  return `https://orcid.org/${canonical}`
}

function authors(values) {
  return values.slice(0, 128).map((author, index) => ({
    name: text(author.name, `author ${index} name`, 512),
    orcid: normalizeOrcid(author.orcid),
  }))
}

function subjects(values) {
  return [...new Set(values.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => text(item, 'subject', 512)))].sort().slice(0, 64)
}

function relation(type, scheme, value, source = null, assertedAt = null, recordId = null) {
  const target = identifier(scheme, value)
  if (target === null) return null
  return {
    type,
    identifier: target,
    source: optionalText(source, 'relation source', 128),
    assertedAt: instant(assertedAt),
    recordId: optionalText(recordId === null ? null : String(recordId), 'relation record ID', 128),
  }
}

function relations(values) {
  return values.filter((item) => item !== null).sort((left, right) => {
    const a = `${left.type}:${left.identifier.scheme}:${left.identifier.value}:${left.source ?? ''}:${left.recordId ?? ''}`
    const b = `${right.type}:${right.identifier.scheme}:${right.identifier.value}:${right.source ?? ''}:${right.recordId ?? ''}`
    return a.localeCompare(b)
  })
}

function observation(base, context) {
  const sourceRecordId = text(base.sourceRecordId, 'source record ID', 512)
  const idSeed = `${context.sourceId}\u0000${sourceRecordId}\u0000${context.payloadReceipt}`
  const idDigest = sha256Bytes(Buffer.from(idSeed)).slice('sha256:'.length, 'sha256:'.length + 16)
  const result = {
    schema: 'kingdom.research-observation/0.1',
    id: `observation:${context.sourceId}:${idDigest}`,
    sourceId: context.sourceId,
    sourceRecordId,
    observedAt: context.observedAt,
    upstreamCreatedAt: instant(base.upstreamCreatedAt),
    upstreamUpdatedAt: instant(base.upstreamUpdatedAt),
    recordType: base.recordType,
    canonicalUrl: httpsUrl(base.canonicalUrl, `https://example.invalid/research/${encodeURIComponent(sourceRecordId)}`),
    title: text(base.title, 'title'),
    authors: authors(base.authors ?? []),
    publishedOn: isoDate(base.publishedOn),
    language: language(base.language),
    subjects: subjects(base.subjects ?? []),
    identifiers: identifiers(base.identifiers ?? []).map((item) => item.scheme === 'source' && !item.value.startsWith(`${context.sourceId}:`)
      ? { ...item, value: `${context.sourceId}:${item.value}` }
      : item),
    relations: relations(base.relations ?? []).map((item) => item.identifier.scheme === 'source' && !item.identifier.value.startsWith(`${context.sourceId}:`)
      ? { ...item, identifier: { ...item.identifier, value: `${context.sourceId}:${item.identifier.value}` } }
      : item),
    reviewState: base.reviewState,
    status: base.status ?? 'unknown',
    sourceStatus: optionalText(base.sourceStatus, 'source status', 256),
    version: text(String(base.version ?? 'unspecified'), 'version', 128),
    itemLicense: optionalText(base.itemLicense, 'item licence', 512),
    payloadReceipt: context.payloadReceipt,
    payloadBytes: context.payloadBytes,
    synthetic: context.synthetic,
    inert: true,
  }
  if (result.identifiers.length === 0) result.identifiers.push(identifier('source', `${context.sourceId}:${sourceRecordId}`))
  return result
}

function updateToRelationType(value) {
  const lowered = String(value ?? '').toLowerCase()
  if (lowered.includes('retract') || lowered.includes('withdraw')) return 'retracts'
  if (lowered.includes('correct') || lowered.includes('errat') || lowered.includes('corrig')) return 'corrects'
  return 'updates'
}

function depositedRelationType(value) {
  const exact = new Map([
    ['is-preprint-of', 'is-preprint-of'],
    ['has-preprint', 'has-preprint'],
    ['is-version-of', 'is-version-of'],
    ['has-version', 'has-version'],
    ['is-supplement-to', 'is-supplement-to'],
    ['is-supplemented-by', 'is-supplemented-by'],
    ['corrects', 'corrects'],
    ['is-corrected-by', 'is-corrected-by'],
    ['retracts', 'retracts'],
    ['is-retracted-by', 'is-retracted-by'],
    ['updates', 'updates'],
    ['is-updated-by', 'is-updated-by'],
  ])
  return exact.get(String(value ?? '').toLowerCase()) ?? null
}

function crossrefRelations(item) {
  const result = []
  for (const update of item['update-to'] ?? []) {
    result.push(relation(
      updateToRelationType(update.type),
      'doi',
      update.DOI,
      update.source ?? 'publisher',
      update.updated?.['date-time'] ?? null,
      update['record-id'] ?? null,
    ))
  }
  for (const [name, entries] of Object.entries(item.relation ?? {})) {
    if (!Array.isArray(entries)) continue
    const type = depositedRelationType(name)
    if (type === null) continue
    for (const entry of entries) {
      const scheme = String(entry['id-type'] ?? '').toLowerCase() === 'doi' ? 'doi' : 'source'
      result.push(relation(type, scheme, entry.id, 'crossref-deposit'))
    }
  }
  return result
}

function normalizeCrossref(data, context, updatesOnly) {
  const items = data?.message?.items
  if (!Array.isArray(items)) throw new TypeError('Crossref payload must contain message.items')
  const records = []
  for (const item of items) {
    const doi = identifier('doi', item.DOI)
    if (doi === null) throw new TypeError('Crossref item lacks DOI')
    const updateRelations = crossrefRelations(item)
    if (updatesOnly && (item['update-to'] ?? []).length === 0) continue
    const isNotice = updatesOnly || (item['update-to'] ?? []).length > 0 || ['retraction', 'correction', 'erratum', 'withdrawal'].includes(String(item.subtype).toLowerCase())
    const recordType = isNotice
      ? 'status-update'
      : item.type === 'posted-content'
        ? 'preprint'
        : item.type === 'dataset'
          ? 'dataset'
          : item.type === 'software'
            ? 'software'
            : 'publication'
    const names = (item.author ?? []).map((author) => ({
      name: [author.given, author.family].filter(Boolean).join(' '),
      orcid: author.ORCID ?? null,
    })).filter((author) => author.name !== '')
    records.push(observation({
      sourceRecordId: item.DOI,
      upstreamCreatedAt: item.created?.['date-time'] ?? null,
      upstreamUpdatedAt: item.indexed?.['date-time'] ?? item.created?.['date-time'] ?? null,
      recordType,
      canonicalUrl: item.URL ?? `https://doi.org/${doi.value}`,
      title: item.title?.[0] ?? `Untitled Crossref record ${item.DOI}`,
      authors: names,
      publishedOn: crossrefDate(item.published ?? item.created),
      language: item.language ?? null,
      subjects: item.subject ?? [],
      identifiers: [doi],
      relations: updateRelations,
      reviewState: isNotice ? 'status-notice' : recordType === 'preprint' ? 'preprint' : recordType === 'dataset' ? 'dataset' : recordType === 'software' ? 'software' : 'unknown',
      status: String(item.subtype).toLowerCase() === 'withdrawal' ? 'withdrawn' : 'active',
      sourceStatus: item.subtype ?? item.type ?? null,
      version: item.subtype ?? item.type ?? 'unspecified',
      itemLicense: item.license?.[0]?.URL ?? null,
    }, context))
  }
  return { records, nextCursor: optionalText(data.message['next-cursor'], 'Crossref cursor', 4096), rawItemCount: items.length }
}

function dataciteRelationType(value) {
  const exact = new Map([
    ['ispreprintof', 'is-preprint-of'],
    ['haspreprint', 'has-preprint'],
    ['isversionof', 'is-version-of'],
    ['isnewversionof', 'is-version-of'],
    ['ispreviousversionof', 'has-version'],
    ['hasversion', 'has-version'],
    ['issupplementto', 'is-supplement-to'],
    ['issupplementedby', 'is-supplemented-by'],
    ['corrects', 'corrects'],
    ['iscorrectedby', 'is-corrected-by'],
    ['retracts', 'retracts'],
    ['isretractedby', 'is-retracted-by'],
    ['updates', 'updates'],
    ['isupdatedby', 'is-updated-by'],
  ])
  return exact.get(String(value ?? '').toLowerCase()) ?? null
}

function normalizeDatacite(data, context) {
  if (!Array.isArray(data?.data)) throw new TypeError('DataCite payload must contain data array')
  const records = data.data.map((item) => {
    const attributes = item.attributes ?? {}
    const doi = identifier('doi', attributes.doi ?? item.id)
    if (doi === null) throw new TypeError('DataCite item lacks DOI')
    const typeName = String(attributes.types?.resourceTypeGeneral ?? '').toLowerCase()
    const recordType = typeName === 'dataset' ? 'dataset' : typeName === 'software' ? 'software' : typeName === 'preprint' ? 'preprint' : 'publication'
    return observation({
      sourceRecordId: attributes.doi ?? item.id,
      upstreamCreatedAt: attributes.created ?? null,
      upstreamUpdatedAt: attributes.updated ?? attributes.created ?? null,
      recordType,
      canonicalUrl: attributes.url ?? `https://doi.org/${doi.value}`,
      title: attributes.titles?.[0]?.title ?? `Untitled DataCite record ${doi.value}`,
      authors: (attributes.creators ?? []).map((creator) => ({
        name: creator.name ?? [creator.givenName, creator.familyName].filter(Boolean).join(' '),
        orcid: creator.nameIdentifiers?.find((entry) => String(entry.nameIdentifierScheme).toLowerCase() === 'orcid')?.nameIdentifier ?? null,
      })),
      publishedOn: isoDate(attributes.published) ?? isoDate(attributes.created),
      language: attributes.language ?? null,
      subjects: (attributes.subjects ?? []).map((entry) => entry.subject),
      identifiers: [doi],
      relations: (attributes.relatedIdentifiers ?? []).map((entry) => {
        const type = dataciteRelationType(entry.relationType)
        if (type === null) return null
        return relation(
          type,
          String(entry.relatedIdentifierType).toLowerCase() === 'doi' ? 'doi' : 'source',
          entry.relatedIdentifier,
          'datacite-deposit',
          attributes.updated ?? null,
        )
      }),
      reviewState: recordType === 'dataset' ? 'dataset' : recordType === 'software' ? 'software' : recordType === 'preprint' ? 'preprint' : 'unknown',
      status: attributes.state === 'registered' ? 'unknown' : 'active',
      sourceStatus: attributes.state ?? null,
      version: attributes.version ?? attributes.types?.resourceType ?? attributes.types?.resourceTypeGeneral ?? 'unspecified',
      itemLicense: attributes.rightsList?.[0]?.rightsIdentifier ?? attributes.rightsList?.[0]?.rights ?? null,
    }, context)
  })
  const next = data.links?.next
  return { records, nextCursor: next === null || next === undefined ? null : new URL(next).searchParams.get('page[cursor]'), rawItemCount: data.data.length }
}

function normalizeOpenalex(data, context) {
  if (!Array.isArray(data?.results)) throw new TypeError('OpenAlex payload must contain results')
  const records = data.results.map((item) => {
    const openalex = identifier('openalex', item.id ?? item.ids?.openalex)
    if (openalex === null) throw new TypeError('OpenAlex item lacks ID')
    const type = String(item.type ?? '').toLowerCase()
    return observation({
      sourceRecordId: openalex.value,
      upstreamCreatedAt: item.created_date ?? null,
      upstreamUpdatedAt: item.updated_date ?? null,
      recordType: type === 'dataset' ? 'dataset' : type === 'software' ? 'software' : type === 'preprint' ? 'preprint' : 'publication',
      canonicalUrl: item.primary_location?.landing_page_url ?? item.doi ?? item.id,
      title: item.title ?? item.display_name ?? `Untitled OpenAlex record ${openalex.value}`,
      authors: (item.authorships ?? []).map((entry) => ({ name: entry.author?.display_name, orcid: entry.author?.orcid ?? null })).filter((entry) => entry.name),
      publishedOn: item.publication_date ?? null,
      language: item.language ?? null,
      subjects: (item.topics ?? []).map((topic) => topic.display_name),
      identifiers: [
        openalex,
        identifier('doi', item.doi ?? item.ids?.doi),
        identifier('pmid', item.ids?.pmid),
        identifier('pmcid', item.ids?.pmcid),
      ],
      relations: [],
      reviewState: type === 'preprint' ? 'preprint' : 'unknown',
      status: item.is_retracted === true ? 'retracted' : 'active',
      sourceStatus: item.is_retracted === true ? 'retracted' : null,
      version: item.version ?? (type || 'unspecified'),
      itemLicense: item.primary_location?.license ?? null,
    }, context)
  })
  return { records, nextCursor: optionalText(data.meta?.next_cursor, 'OpenAlex cursor', 4096), rawItemCount: data.results.length }
}

function normalizePubmed(data, context) {
  const uids = data?.result?.uids
  if (!Array.isArray(uids)) throw new TypeError('PubMed payload must contain result.uids')
  return {
    records: uids.map((uid) => {
      const item = data.result[uid]
      const articleIds = item?.articleids ?? []
      const id = (kind) => articleIds.find((entry) => entry.idtype === kind)?.value
      return observation({
        sourceRecordId: String(uid),
        upstreamCreatedAt: item.sortpubdate ?? null,
        upstreamUpdatedAt: item.lastupdated ?? null,
        recordType: 'publication',
        canonicalUrl: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(uid)}/`,
        title: item.title,
        authors: (item.authors ?? []).map((author) => ({ name: author.name, orcid: null })),
        publishedOn: isoDate(item.sortpubdate),
        language: item.lang,
        subjects: item.pubtype ?? [],
        identifiers: [identifier('pmid', uid), identifier('pmcid', id('pmc')), identifier('doi', id('doi'))],
        relations: [],
        reviewState: 'unknown',
        status: 'active',
        sourceStatus: null,
        version: 'pubmed-citation',
        itemLicense: null,
      }, context)
    }),
    nextCursor: null,
    rawItemCount: uids.length,
  }
}

function normalizeEuropePmc(data, context) {
  const items = data?.resultList?.result
  if (!Array.isArray(items)) throw new TypeError('Europe PMC payload must contain resultList.result')
  return {
    records: items.map((item) => {
      const sourceRecordId = `${item.source ?? 'EPMC'}:${item.id ?? item.pmid ?? item.pmcid}`
      const isPreprint = String(item.pubType ?? item.pubTypeList?.pubType?.join(' ') ?? '').toLowerCase().includes('preprint')
      return observation({
        sourceRecordId,
        upstreamCreatedAt: item.dateOfCreation ? `${item.dateOfCreation}T00:00:00Z` : null,
        upstreamUpdatedAt: item.dateOfRevision ? `${item.dateOfRevision}T00:00:00Z` : item.dateOfCreation ? `${item.dateOfCreation}T00:00:00Z` : null,
        recordType: isPreprint ? 'preprint' : 'publication',
        canonicalUrl: item.doi ? `https://doi.org/${item.doi}` : item.pmid ? `https://europepmc.org/article/MED/${item.pmid}` : `https://europepmc.org/article/${item.source}/${item.id}`,
        title: item.title ?? `Untitled Europe PMC record ${sourceRecordId}`,
        authors: String(item.authorString ?? '').split(/\s*,\s*/u).filter(Boolean).map((name) => ({ name, orcid: null })),
        publishedOn: item.firstPublicationDate ?? null,
        language: item.language ?? null,
        subjects: item.pubTypeList?.pubType ?? [],
        identifiers: [identifier('pmid', item.pmid), identifier('pmcid', item.pmcid), identifier('doi', item.doi), identifier('source', sourceRecordId)],
        relations: [],
        reviewState: isPreprint ? 'preprint' : 'unknown',
        status: String(item.isRetracted).toUpperCase() === 'Y' ? 'retracted' : 'active',
        sourceStatus: String(item.isRetracted).toUpperCase() === 'Y' ? 'retracted' : null,
        version: isPreprint ? 'preprint' : 'indexed-publication',
        itemLicense: item.license ?? null,
      }, context)
    }),
    nextCursor: optionalText(data.nextCursorMark, 'Europe PMC cursor', 4096),
    rawItemCount: items.length,
  }
}

function normalizeBiorxiv(data, context) {
  if (!Array.isArray(data?.collection)) throw new TypeError('bioRxiv payload must contain collection')
  const message = data.messages?.[0] ?? {}
  const start = Number(message.cursor ?? 0)
  const total = Number(message.total ?? data.collection.length)
  const next = start + data.collection.length < total ? String(start + data.collection.length) : null
  return {
    records: data.collection.map((item) => observation({
      sourceRecordId: `${item.server ?? 'biorxiv'}:${item.doi}:v${item.version}`,
      upstreamCreatedAt: item.date ? `${item.date}T00:00:00Z` : null,
      upstreamUpdatedAt: item.date ? `${item.date}T00:00:00Z` : null,
      recordType: 'preprint',
      canonicalUrl: `https://doi.org/${item.doi}`,
      title: item.title,
      authors: String(item.authors ?? '').split(/\s*;\s*/u).filter(Boolean).map((name) => ({ name, orcid: null })),
      publishedOn: item.date ?? null,
      language: 'en',
      subjects: [item.category].filter(Boolean),
      identifiers: [identifier('doi', item.doi)],
      relations: item.published && item.published !== 'NA'
        ? [relation('is-preprint-of', 'doi', item.published, item.server ?? 'biorxiv', item.date)]
        : [],
      reviewState: 'preprint',
      status: String(item.type).toLowerCase().includes('withdraw') ? 'withdrawn' : 'active',
      sourceStatus: item.type ?? null,
      version: `v${item.version}`,
      itemLicense: item.license ?? null,
    }, context)),
    nextCursor: next,
    rawItemCount: data.collection.length,
  }
}

function normalizeClinicalTrials(data, context) {
  if (!Array.isArray(data?.studies)) throw new TypeError('ClinicalTrials.gov payload must contain studies')
  return {
    records: data.studies.map((study) => {
      const protocol = study.protocolSection ?? {}
      const identification = protocol.identificationModule ?? {}
      const status = protocol.statusModule ?? {}
      const contacts = protocol.contactsLocationsModule ?? {}
      const nct = identification.nctId
      if (typeof nct !== 'string') throw new TypeError('ClinicalTrials.gov study lacks NCT ID')
      return observation({
        sourceRecordId: nct,
        upstreamCreatedAt: status.studyFirstPostDateStruct?.date ? `${status.studyFirstPostDateStruct.date}T00:00:00Z` : null,
        upstreamUpdatedAt: status.lastUpdatePostDateStruct?.date ? `${status.lastUpdatePostDateStruct.date}T00:00:00Z` : null,
        recordType: 'trial',
        canonicalUrl: `https://clinicaltrials.gov/study/${nct}`,
        title: identification.briefTitle ?? identification.officialTitle ?? `Untitled study ${nct}`,
        authors: [],
        publishedOn: status.studyFirstPostDateStruct?.date ?? status.studyFirstSubmitDate ?? null,
        language: 'en',
        subjects: [
          ...(protocol.conditionsModule?.conditions ?? []),
          ...(study.derivedSection?.conditionBrowseModule?.meshes ?? []).map((entry) => entry.term),
        ],
        identifiers: [identifier('nct', nct)],
        relations: [],
        reviewState: 'registered-study',
        status: String(status.overallStatus) === 'WITHDRAWN'
          ? 'withdrawn'
          : ['NOT_YET_RECRUITING', 'RECRUITING', 'ENROLLING_BY_INVITATION', 'ACTIVE_NOT_RECRUITING', 'COMPLETED'].includes(String(status.overallStatus))
            ? 'active'
            : 'unknown',
        sourceStatus: status.overallStatus ?? null,
        version: study.derivedSection?.miscInfoModule?.versionHolder ?? status.lastUpdatePostDateStruct?.date ?? 'registered',
        itemLicense: null,
      }, context)
    }),
    nextCursor: optionalText(data.nextPageToken, 'ClinicalTrials.gov cursor', 4096),
    rawItemCount: data.studies.length,
  }
}

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&')
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function xmlTag(block, name) {
  const match = block.match(new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${name}>`, 'iu'))
  return match === null ? null : decodeXml(match[1].replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim()
}

function xmlBlocks(block, name) {
  return [...block.matchAll(new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:(?:[A-Za-z0-9_-]+):)?${name}>`, 'giu'))].map((match) => match[0])
}

function normalizeArxivXml(xml, context) {
  const isAtom = /<feed[\s>]/iu.test(xml)
  const blocks = xmlBlocks(xml, isAtom ? 'entry' : 'record')
  const records = blocks.map((block) => {
    const rawId = xmlTag(block, 'id') ?? xmlTag(block, 'identifier')
    if (rawId === null) throw new TypeError('arXiv record lacks an identifier')
    const arxivId = String(rawId).replace(/^oai:arXiv\.org:/iu, '').replace(/^https?:\/\/arxiv\.org\/abs\//iu, '').replace(/v\d+$/u, '')
    if (arxivId === '' || arxivId === 'null') throw new TypeError('arXiv record has an invalid identifier')
    const updated = xmlTag(block, 'updated') ?? xmlTag(block, 'datestamp')
    const published = xmlTag(block, 'published') ?? xmlTag(block, 'created')
    const authorValues = xmlBlocks(block, 'author').map((author) => {
      const atomName = xmlTag(author, 'name')
      return { name: atomName ?? [xmlTag(author, 'forenames'), xmlTag(author, 'keyname')].filter(Boolean).join(' '), orcid: null }
    })
    const categories = isAtom
      ? [...block.matchAll(/<category\s+[^>]*term=["']([^"']+)["'][^>]*\/?\s*>/giu)].map((match) => decodeXml(match[1]))
      : String(xmlTag(block, 'categories') ?? '').split(/\s+/u).filter(Boolean)
    const doi = xmlTag(block, 'doi')
    return observation({
      sourceRecordId: arxivId,
      upstreamCreatedAt: published,
      upstreamUpdatedAt: updated,
      recordType: 'preprint',
      canonicalUrl: `https://arxiv.org/abs/${arxivId}`,
      title: xmlTag(block, 'title') ?? `Untitled arXiv record ${arxivId}`,
      authors: authorValues,
      publishedOn: published,
      language: 'en',
      subjects: categories,
      identifiers: [identifier('arxiv', arxivId)],
      relations: doi === null ? [] : [relation('is-preprint-of', 'doi', doi, 'arxiv-metadata', updated)],
      reviewState: 'preprint',
      status: /status=["']deleted["']/iu.test(block) ? 'withdrawn' : 'active',
      sourceStatus: /status=["']deleted["']/iu.test(block) ? 'deleted' : null,
      version: rawId?.match(/v\d+$/u)?.[0] ?? 'latest-observed',
      itemLicense: xmlTag(block, 'license'),
    }, context)
  })
  if (isAtom) {
    const total = Number(xmlTag(xml, 'totalResults') ?? records.length)
    const start = Number(xmlTag(xml, 'startIndex') ?? 0)
    const next = start + records.length < total ? String(start + records.length) : null
    return { records, nextCursor: next, rawItemCount: blocks.length }
  }
  return { records, nextCursor: optionalText(xmlTag(xml, 'resumptionToken'), 'arXiv resumption token', 4096), rawItemCount: blocks.length }
}

const NORMALIZERS = Object.freeze({
  arxiv: (value, context) => normalizeArxivXml(value, context),
  biorxiv: normalizeBiorxiv,
  'clinicaltrials-gov': normalizeClinicalTrials,
  crossref: (value, context) => normalizeCrossref(value, context, false),
  'crossref-updates': (value, context) => normalizeCrossref(value, context, true),
  datacite: normalizeDatacite,
  'europe-pmc': normalizeEuropePmc,
  openalex: normalizeOpenalex,
  pubmed: normalizePubmed,
})

export function normalizePayload({ adapter, sourceId, observedAt, bytes, synthetic }) {
  if (!ADAPTER_NAMES.includes(adapter)) throw new RangeError(`unknown adapter ${adapter}`)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) {
    throw new RangeError('payload is outside 1..1048576 bytes')
  }
  if (instant(observedAt) !== observedAt) throw new TypeError('observedAt must be an exact UTC second')
  const context = {
    sourceId,
    observedAt,
    payloadReceipt: sha256Bytes(bytes),
    payloadBytes: bytes.byteLength,
    synthetic: synthetic === true,
  }
  let value
  if (adapter === 'arxiv') {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!value.includes('<')) throw new TypeError('arXiv payload must be XML')
  } else {
    value = parseJsonBytes(bytes, `${adapter} payload`)
    if (synthetic === true && value.synthetic !== true) throw new TypeError('fixture payload must declare synthetic true')
    if (synthetic !== true && value.synthetic === true) throw new TypeError('live payload must not declare itself synthetic')
  }
  const normalized = NORMALIZERS[adapter](value, context)
  return {
    observations: normalized.records,
    nextCursor: normalized.nextCursor,
    rawItemCount: normalized.rawItemCount ?? normalized.records.length,
  }
}
