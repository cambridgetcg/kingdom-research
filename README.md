# KINGDOM Research

KINGDOM Research is a small Observatory for discovering current research that
may matter to the KINGDOM. Its MVP ingests **metadata only**, preserves source
observations, resolves only exact identifiers, and emits an inert public
snapshot.

It does not fetch full text, assess scientific truth, execute artifacts,
install dependencies, admit guests, generate modules, adopt resources, or
authorise use.

## The four gates

```text
discovery  ->  separately owned evaluation  ->  explicit adoption  ->  bounded use authority
    this repository stops here ^
```

The public snapshot therefore records every work as `observed`,
`not-performed`, `not-recorded`, and `not-authorized` at those four gates. A
high-priority signal only orders human attention.

After evaluation, two deliberately different routes may be proposed elsewhere:

- **Module path:** KINGDOM owns and maintains an adapter or implementation.
- **Guest path:** upstream ownership remains external; access must be narrow,
  attributable, revocable, monitored, and time-limited.

Neither route is proposed or activated by this MVP. See [OBSERVATORY.md](OBSERVATORY.md).

## Offline commands

Node 20 or newer is the only runtime requirement. There are no npm
dependencies.

```sh
npm test
npm run validate
npm run build
npm run build:check
# optional synthetic rehearsal, isolated from the public artifact:
npm run validate:fixtures
npm run build:fixtures
npm run build:fixtures:check
```

- `validate` checks the schemas, manifests, imported live envelopes,
  normalized observations, works, signals, and captured-live snapshot.
- `build` atomically writes the canonical captured-live
  `public/research.json`; it rejects an empty capture set and publishes zero
  synthetic observations. `build:live` remains an alias.
- `build:check` rebuilds in memory and fails if the checked-in snapshot
  differs byte-for-byte.
- The explicit `*:fixtures` commands validate or write a synthetic rehearsal
  under ignored `.local/`; they cannot overwrite the public artifact.

The build is deterministic: live `asOf` comes from imported envelope times,
fixture `asOf` comes from the fixture manifest, arrays are sorted, and JSON
keys are emitted canonically. Build and validation never read the clock or
network.

## Explicit live polling

`poll` is a separate, opt-in, one-shot read. It prints a bounded observation
envelope to stdout and persists nothing:

```sh
node src/cli.mjs poll \
  --source crossref \
  --watchlist interpretable-reasoning \
  --watermark 2026-08-20T00:00:00Z \
  --mailto research-operator@example.org \
  --items 25 \
  --pages 1
```

OpenAlex accepts casual keyless calls; a free key is optional and raises the
available budget. When used, it must be supplied indirectly:

```sh
KINGDOM_RESEARCH_OPENALEX_KEY='...' node src/cli.mjs poll \
  --source openalex \
  --watchlist interpretable-reasoning \
  --watermark 2026-08-20T00:00:00Z \
  --mailto research-operator@example.org \
  --api-key-env KINGDOM_RESEARCH_OPENALEX_KEY
```

Supported live adapters are Crossref, DataCite, OpenAlex, arXiv, Europe PMC,
and Crossref update relations. ClinicalTrials.gov remains fixture-only in 0.1
while its zone-less processing timestamp and attribution disclosure are modeled
without inventing UTC. Every live request is HTTPS,
redirect-closed, allowlisted, identified, and subject to hard page, item,
byte, request-time, and total-time limits. The returned envelope carries the
next cursor, before/after watermarks, observation time, byte counts, and the
source's current attributed rights statement. There is no scheduler or
automatic continuation.

To persist a reviewed capture, redirect poll output to an operator-controlled
file and invoke the separate network-free import:

```sh
node src/cli.mjs import-poll /path/to/crossref-poll.json
```

Import rejects changed watchlist terms, unbound cursors, stale rights records,
future source update clocks, duplicate JSON keys, and any evaluation/adoption/
use claim. It appends under `captures/` without replacing history and rebuilds
`public/research.json` in captured-live mode. Raw upstream response bodies are
not retained or recoverable; observations carry only normalized metadata plus
a non-reversible payload receipt and byte count.

## Watchlists

The MVP contains three visible English-language watchlists:

1. interpretable reasoning / J-space / mechanistic interpretability;
2. secure information flow / prompt injection / agent security;
3. natural-language programming / agent interoperability / MCP.

Their exact terms live in `watchlists/manifest.json`. Multilingual expansion
is explicitly absent until reviewed translations exist. Matches emit factor
vectors with evidence and reasons—never a scalar quality score.

## Repository map

```text
sources/manifest.json       attributed source access, freshness, rights, risks
watchlists/manifest.json    explicit needs, terms, and priority factors
schemas/v0.1/               closed JSON Schema contracts
fixtures/raw/               synthetic source-shaped metadata only
src/adapters.mjs            bounded source normalization
src/ingest.mjs              exact-ID resolution and signal derivation
src/live.mjs                the only network-capable code path
src/captures.mjs            append-only capture validation and live rebuild
src/cli.mjs                 validate, build, and explicit poll verbs
public/research.json        deterministic public snapshot
test/                       offline fixture-backed checks
```

All upstream URLs and access/rights claims are dated in the source manifest.
They should be reviewed before enabling a live consumer. A successful local
validation proves only structural consistency of these bytes.
