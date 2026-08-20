#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { importPollEnvelope, PUBLIC_SNAPSHOT_PATH } from './captures.mjs'
import { buildSnapshot, validateBundledData } from './ingest.mjs'
import {
  ROOT,
  atomicWriteInsideRoot,
  parseJsonBytes,
  prettyCanonicalJson,
  readBoundedBytes,
  readExternalBoundedBytes,
  readJson,
  sha256Json,
} from './io.mjs'
import { LIVE_POLICIES, pollSource } from './live.mjs'

const USAGE = `KINGDOM Research Observatory 0.1

Offline by default:
  kingdom-research validate
  kingdom-research build [--check] [--live-only | --fixtures-only] [--output PATH]

Explicit network read, stdout only:
  kingdom-research poll --source ID --watchlist ID --watermark INSTANT --mailto EMAIL
    [--cursor TOKEN] [--items 1..100] [--pages 1..3] [--api-key-env ENV_NAME]

Separate explicit persistence (network-free):
  kingdom-research import-poll CAPTURE.json [--output PATH]

There is no raw URL or caller-supplied query option. Poll terms come only from
the checked-in reviewed watchlist. Import never evaluates, adopts, authorises,
creates a module, or admits a guest.
`

function fail(message) {
  const error = new TypeError(message)
  error.cli = true
  throw error
}

function parseOptions(argv, { booleans = [], values = [] } = {}) {
  const booleanSet = new Set(booleans)
  const valueSet = new Set(values)
  const options = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    if (token.includes('=')) fail(`option values must be separate arguments: ${token}`)
    const name = token.slice(2)
    if (booleanSet.has(name)) {
      if (Object.hasOwn(options, name)) fail(`duplicate option --${name}`)
      options[name] = true
      continue
    }
    if (!valueSet.has(name)) fail(`unknown option --${name}`)
    if (Object.hasOwn(options, name)) fail(`duplicate option --${name}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`option --${name} requires a value`)
    options[name] = value
    index += 1
  }
  return { options, positional }
}

function integerOption(value, fallback, label) {
  if (value === undefined) return fallback
  if (!/^[0-9]+$/u.test(value)) fail(`--${label} must be a decimal integer`)
  const result = Number(value)
  if (!Number.isSafeInteger(result)) fail(`--${label} is outside the safe integer range`)
  return result
}

function outputPath(value) {
  return value === undefined ? PUBLIC_SNAPSHOT_PATH : resolve(ROOT, value)
}

function manifests() {
  return {
    sources: readJson(join(ROOT, 'sources', 'manifest.json')),
    watchlists: readJson(join(ROOT, 'watchlists', 'manifest.json')),
  }
}

function requireOption(options, name) {
  if (typeof options[name] !== 'string' || options[name] === '') fail(`--${name} is required`)
  return options[name]
}

async function commandPoll(argv, write) {
  const { options, positional } = parseOptions(argv, {
    values: ['source', 'watchlist', 'watermark', 'mailto', 'cursor', 'items', 'pages', 'api-key-env'],
  })
  if (positional.length > 0) fail('poll accepts no positional arguments')
  const sourceId = requireOption(options, 'source')
  const watchlistId = requireOption(options, 'watchlist')
  const { sources, watchlists } = manifests()
  const source = sources.sources.find((item) => item.id === sourceId)
  if (source === undefined) fail(`unknown source ${sourceId}`)
  if (LIVE_POLICIES[sourceId] === undefined || source.access.mvpMode !== 'fixture-and-explicit-poll') {
    fail(`source ${sourceId} is not enabled for live polling in this release`)
  }
  const watchlist = watchlists.watchlists.find((item) => item.id === watchlistId)
  if (watchlist === undefined) fail(`unknown watchlist ${watchlistId}`)
  let apiKey = null
  if (options['api-key-env'] !== undefined) {
    const name = options['api-key-env']
    if (!/^[A-Z][A-Z0-9_]{0,79}$/u.test(name)) fail('--api-key-env must name a bounded uppercase environment variable')
    apiKey = process.env[name] ?? null
    if (apiKey === null || apiKey === '') fail('the named API key environment variable is unset')
  }
  const envelope = await pollSource({
    source,
    watchlist,
    watermark: requireOption(options, 'watermark'),
    cursor: options.cursor ?? null,
    items: integerOption(options.items, 25, 'items'),
    pages: integerOption(options.pages, 1, 'pages'),
    mailto: requireOption(options, 'mailto'),
    apiKey,
  })
  write(prettyCanonicalJson(envelope))
}

function commandBuild(argv, write) {
  const { options, positional } = parseOptions(argv, { booleans: ['check', 'live-only', 'fixtures-only'], values: ['output'] })
  if (positional.length > 0) fail('build accepts no positional arguments')
  if (options['live-only'] === true && options['fixtures-only'] === true) fail('--live-only and --fixtures-only are mutually exclusive')
  const path = outputPath(options.output)
  const snapshot = buildSnapshot({
    includeFixtures: options['live-only'] !== true,
    includeCaptures: options['fixtures-only'] !== true,
  })
  const document = prettyCanonicalJson(snapshot)
  if (options.check === true) {
    if (!existsSync(path)) fail(`generated snapshot is missing at ${path}`)
    const current = readBoundedBytes(path, 8 * 1024 * 1024)
    if (!current.equals(Buffer.from(document))) fail('generated snapshot differs; run the matching build command')
    write(`${prettyCanonicalJson({ state: 'current', path, receipt: sha256Json(snapshot) })}`)
    return
  }
  atomicWriteInsideRoot(path, document)
  write(prettyCanonicalJson({
    state: 'built', path, receipt: sha256Json(snapshot), mode: snapshot.mode,
    observations: snapshot.observations.length, works: snapshot.works.length, signals: snapshot.signals.length,
  }))
}

function commandValidate(argv, write) {
  const { options, positional } = parseOptions(argv, { booleans: ['live-only', 'fixtures-only'] })
  if (positional.length > 0) fail('validate accepts no positional arguments')
  if (options['live-only'] === true && options['fixtures-only'] === true) fail('--live-only and --fixtures-only are mutually exclusive')
  write(prettyCanonicalJson(validateBundledData({
    includeFixtures: options['live-only'] !== true,
    includeCaptures: options['fixtures-only'] !== true,
  })))
}

function commandImport(argv, write) {
  const { options, positional } = parseOptions(argv, { values: ['output'] })
  if (positional.length !== 1) fail('import-poll requires exactly one captured poll JSON file')
  const bytes = readExternalBoundedBytes(resolve(positional[0]), 4 * 1024 * 1024)
  const envelope = parseJsonBytes(bytes, 'captured poll envelope')
  const report = importPollEnvelope(envelope, { outputPath: outputPath(options.output) })
  write(prettyCanonicalJson(report))
}

export async function runCli(argv, { write = (value) => process.stdout.write(value) } = {}) {
  const [command = 'help', ...rest] = argv
  if (command === 'help' || command === '--help' || command === '-h') {
    if (rest.length > 0) fail('help accepts no arguments')
    write(USAGE)
    return
  }
  if (command === 'validate') return commandValidate(rest, write)
  if (command === 'build') return commandBuild(rest, write)
  if (command === 'poll') return commandPoll(rest, write)
  if (command === 'import-poll') return commandImport(rest, write)
  fail(`unknown command ${command}`)
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`kingdom-research: ${error.message}\n`)
    process.exitCode = 1
  })
}
