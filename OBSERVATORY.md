# Observatory design

## Purpose

The Observatory is a conversion membrane between public research metadata and
human attention inside the KINGDOM. It answers three bounded questions:

1. What new or changed research records did an identified source report?
2. Which exact identifiers and explicit relations connect those reports?
3. Which named watchlist factors make a record worth reviewing next?

It does not answer whether a claim is true, whether an artifact is safe, or
whether the KINGDOM should adopt or run anything.

## Data flow and stop points

```text
allowlisted metadata source
  -> bounded source response read transiently
  -> normalized inert observation + non-reversible byte receipt
  -> exact-identifier work resolution
  -> explainable signals and watchlist factors
  -> public metadata snapshot
  -> STOP: human may request a separately owned evaluation

evaluation record
  -> STOP: project owner may make an explicit adoption record

adoption record
  -> choose one path, still without use:
       module candidate -> KINGDOM-owned implementation and review
       guest candidate  -> external ownership + capability contract
  -> STOP: a separate, expiring use authority is required
```

The four lifecycle fields deliberately use different vocabularies. Code must
not infer a later field from an earlier one. Likewise, `module` and `guest`
are mutually distinct dispositions, not synonyms for “interesting.”

## Entities

- A **source** is an attributed upstream metadata service with access,
  freshness, rights, identifier, and risk claims observed on a stated date.
- An **observation** is what one source reported at one time, bound to a
  non-reversible SHA-256 receipt and byte count for the transient source
  response. Fixture observations are synthetic; imported live observations are
  explicitly non-synthetic. Both remain inert. Raw upstream bodies are not
  retained, recoverable, or independently replayable in 0.1.
- A **work** is a local exact-identifier cluster. Shared DOI, PMID, PMCID,
  arXiv ID, NCT ID, or OpenAlex ID can join observations. An explicit relation
  creates an edge, not an automatic merge.
- A **signal** is a reproducible reason to look: status change, explicit
  publication relation, multiple-source corroboration, version activity, or a
  watchlist match. It is neither an endorsement nor an authority record.
- A **public snapshot** is a deterministic projection of the above plus the
  boundary declarations. It contains no full text.

Fuzzy title/author matching is intentionally absent in 0.1. It can be added
only as a proposed-equivalence signal that requires review.

## Priority without a magic score

Each watchlist names its keywords and factor template. A match records a
vector such as:

```json
[
  {
    "factor": "named-need-fit",
    "level": "high",
    "evidence": ["mechanistic interpretability"],
    "reason": "The title contains a reviewed watchlist phrase."
  },
  {
    "factor": "review-state",
    "level": "unknown",
    "evidence": ["preprint"],
    "reason": "The source reports a preprint, not completed peer review."
  }
]
```

There is no numeric total. Freshness does not mean truth, citations do not mean
value, institutional prestige is not a factor, and a retraction alert cannot
be averaged away by other factors.

The initial terms are English because those are the only reviewed terms in
this repository. `multilingualExpansion.state` remains `absent`; the system
must not fabricate translations or silently treat English coverage as global.

## Live transport contract

Importing modules, validating, building, and testing are offline. Only the
explicit `poll` verb receives a transport.

One poll invocation:

- accepts one named source, one checked-in watchlist, ISO watermark, optional bound cursor, caller
  contact, one-to-three pages, and one-to-100 items per page;
- validates the source against an exact HTTPS host and path-prefix allowlist;
- sends an identifying user agent and source-specific contact/key parameter;
- rejects redirects, non-JSON/non-XML content, oversize responses, slow
  requests, an expired total budget, and more records than requested;
- sleeps between arXiv pages to respect its published interval;
- emits observations plus cursor, watermarks, observed times, response byte
  counts, and the full source rights record;
- writes no cursor, cache, fixture, snapshot, log, or credential.

The emitted continuation binds the source, watchlist, reviewed-term receipt,
starting watermark, item bound, query mode, provider cursor, and accumulated
high-water checkpoint. `import-poll` is a separate, network-free write: it
validates that envelope, appends it without replacing history, projects a
bounded live-only snapshot, and still performs no evaluation or promotion.

The API key is read from the explicitly named environment variable only for
OpenAlex. Its value is placed in the request URL required by that API but is
never included in output or error messages. Tests inject local response bytes;
they never call live hosts.

## Rights and safety

The source manifest distinguishes metadata reuse from linked-content reuse.
This MVP never requests full-text endpoints, follows artifact links, renders
documents, clones repositories, installs packages, or invokes discovered
commands. All strings are treated as untrusted inert metadata.

A malicious title or abstract can still carry prompt-injection text. Consumers
must display it as quoted source data and must not concatenate it into an
authority-bearing instruction channel. URLs are data, not actions.

Corrections and retractions append source observations and produce prominent
integrity signals. They do not delete history or become an unqualified verdict
about every related version.

## Module and guest paths after the MVP

The Observatory can eventually draft either candidate, never enact it:

| Path | Ownership | Minimum later evidence | Minimum later controls |
| --- | --- | --- | --- |
| Module | KINGDOM owns adapter/implementation | project-owned evaluation, exact upstream/artifact pin, rights review, tests | reviewed change, dependency lock, rollback, maintenance owner |
| Guest | upstream remains external | evaluation, identity/provenance claim, interface and data-flow review | deny-by-default capabilities, no ambient secrets/network, expiry, brake, monitoring, removal |

Both paths still require a separate adoption record and an even later bounded
use authority. A generated patch, candidate card, or passing sandbox trial is
not either authority.

## Deliberately deferred

- full text, PDF/XML/JATS body ingestion, embeddings, and model-generated
  summaries;
- fuzzy identity resolution and author/institution disambiguation;
- patents, grants, WHO ICTRP, Semantic Scholar, OpenAIRE, and OpenCitations;
- scheduling, notification delivery, accounts, private watchlists, and stateful
  cursor storage;
- evaluation, reproduction, code generation, sandbox execution, module
  publication, guest admission, deployment, or registry writes.

Those are later projects with their own rights, threat models, owners, brakes,
and human gates.
