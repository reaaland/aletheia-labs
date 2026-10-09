# Aletheia Labs — research core (MVP #1)

A provider-agnostic research-and-verification engine. Given a technical question it
queries several independent retrieval paths, extracts claims, grades each claim against
a versioned rubric, surfaces disagreements instead of averaging them, writes a cited
verdict, and appends the whole thing to an append-only evidence ledger.

**It runs with zero credentials.** Every provider is behind an adapter, the default
reasoner is deterministic, and the default retrieval paths need no key. No provider —
OpenAI, Ollama, SearXNG, or anything else — is load-bearing.

## Quick start

```sh
cd /home/team/shared/engine
bun install          # no dependencies to fetch; the engine has none
bun run research "Is the built-in punycode module deprecated in Node.js, and what should replace it?"
```

Requirements: Bun ≥ 1.1 (uses `bun:sqlite`, `bun:test`, `Bun.serve`). Nothing else.
There is no `npm install` step, no lockfile to reconcile, and no `.env` file.

Useful flags:

```sh
bun run research "<question>" --json                    # machine-readable report
bun run research "<question>" --source https://x/y      # add a URL to fetch directly (repeatable)
bun run research "<question>" --out report.md           # also write the Markdown report
bun run research "<question>" --retrieval direct-url,qa-forum
bun run research "<question>" --offline                 # disable every network path
bun run research adapters                               # what is available right now, and why
bun run research ledger list                            # recent ledger entries
bun run research ledger show <runId>                    # one entry, verbatim
bun run research ledger verify                          # recompute the hash chain
bun run research rubric                                 # the rubric currently in force
bun test                                                # 42 tests, no network, no keys
```

## The demo run

The recorded run in `demo-report.md` was produced by exactly this command, on live
sources, with no API keys set in the environment:

```sh
bun run research "Is the built-in punycode module deprecated in Node.js, and what should replace it? Is the npm punycode package also deprecated?" \
  --source https://nodejs.org/api/deprecations.html \
  --out demo-report.md --timeout 15000
```

## How a run works

```
question
  │
  ├─ retrieval adapters (all independent, run concurrently, each can fail alone)
  │     direct-url · web-search · package-registry · code-host · qa-forum · reference-docs
  │        ↓ normalised SourceDoc[] with url, text, date, retrieval path, source class
  ├─ claim extraction      grade/extract.ts   (deterministic cues + polarity)
  ├─ clustering            grade/cluster.ts   (single-link, Jaccard, deterministic)
  ├─ scoring               grade/rubric.ts    (weights loaded from rubric/v1.json)
  ├─ conflict detection    grade/conflicts.ts (polarity + value; never averaged)
  ├─ confidence            grade/confidence.ts (computed from recorded inputs)
  ├─ verdict prose         reasoning/*         (one reasoner: deterministic templates, no model)
  └─ ledger append         ledger/*            (SQLite file by default; Postgres optional)
```

Ordering is fixed everywhere, so the same question against the same sources yields the
same scores. Only the set of live sources varies between runs.

## Retrieval adapters

All six sit behind one interface (`RetrievalAdapter`). An adapter that is unconfigured,
rate-limited, blocked or buggy returns a classified outcome instead of throwing; the run
continues on the adapters that answered and the report lists exactly which path was
unavailable and why.

| adapter | what it is | key needed |
| --- | --- | --- |
| `direct-url` | fetch URLs you supply with `--source` | none |
| `web-search` | general web-search API, pluggable backends, then fetches the pages it finds | none for the default backends |
| `package-registry` | npm, PyPI and Maven registry metadata (versions, deprecation flags, yank status) | none |
| `code-host` | GitHub issues, pull requests and releases (maintainer-written text) | none (a token only raises rate limits) |
| `qa-forum` | Stack Exchange network (practitioner-written answers) | none (a key only raises the quota) |
| `reference-docs` | MDN and MediaWiki reference APIs | none |

`web-search` is one adapter with interchangeable backends: `hn-algolia` and `marginalia`
(key-free, default) plus `brave`, `tavily`, `serper`, `google-cse` and `mojeek`, which
stay inert until their key exists in the environment. Select with
`ALETHEIA_WEBSEARCH_BACKENDS`.

### Adding a retrieval adapter

1. Create `src/retrieval/my-provider.ts` exporting an object satisfying `RetrievalAdapter`:

```ts
import type { AdapterOutcome, RetrievalAdapter, RetrievalRequest } from "../types.ts";

export const myProvider: RetrievalAdapter = {
  layer: "retrieval",
  id: "my-provider",
  label: "My provider",
  description: "What it reads and why it is worth having.",
  configKeys: ["MY_PROVIDER_KEY"],     // [] if it needs no credential
  available: (env) => Boolean(env.MY_PROVIDER_KEY),   // false => recorded as unconfigured
  async retrieve(req: RetrievalRequest): Promise<AdapterOutcome> {
    // Never throw. Return unavailableOutcome(...) / okOutcome(...) from ./common.ts.
  },
};
```

2. Add it to the list in `src/retrieval/index.ts`.
3. If it maps URLs to a new kind of host, add a `sourceClassRules.upgrade` entry to
   `rubric/v1.json` so its sources are classified — classification is data, not code.

Nothing else changes: the pipeline never special-cases an adapter id.

## The reasoning layer: one implementation, no model

The pipeline asks a `ReasoningAdapter` for **prose only**; claim extraction, scoring,
conflicts and the confidence number are computed before it runs and are never touched by
it. There is exactly one adapter — `heuristic`, in `src/reasoning/heuristic.ts` — and it is
deterministic: fixed sentence templates over the graded evidence, quoting dissent verbatim.
Same evidence in, byte-identical verdict out, with no network, no key and no model.

**No model sits anywhere in this pipeline.** That is a requirement, not a default, so it is
made checkable rather than configurable:

- `allReasoningAdapters()` returns a one-element list. There is no registry of models and no
  environment variable that selects one; `--reasoning` does not exist.
- `ReasoningResult["mode"]` has exactly one variant, `"deterministic_template"`. There is no
  `model_drafted` state for the ledger to record.
- The ledger entry's `verdict` block records the adapter id and mode; there is no backend or
  provider field, because there is nothing to record.
- A test scans every file under `src/` for model-plumbing identifiers and provider names
  (`LLM_`, `*-llm`, `model_drafted`, `openai`, `anthropic`, `ollama`, `searxng`,
  `chat/completions`, `huggingface`) and fails if any of them reappear. An auditor can
  confirm the absence by running `bun test`, or by reading `src/reasoning/`, which is two
  files.

The `ReasoningAdapter` interface is kept, because the prose layer is conceptually separate
from grading and one implementation behind an interface is easier to test — but adding a
second one would mean editing source that a reviewer reads in full.

## The evidence-grading rubric

`rubric/v1.json` — versioned data, not code. Four weighted dimensions that sum to 1.0:

| dimension | weight | what it measures |
| --- | --- | --- |
| `sourceClass` | 0.35 | primary docs > first-party changelog > vendor blog > Q&A > aggregator |
| `corroboration` | 0.25 | independent **registrable domains** asserting the same proposition |
| `recency` | 0.20 | exponential decay, 540-day half-life, explicit score for undated sources |
| `specificity` | 0.20 | version / identifier / date / URL / numeric tokens |

Every score records `dimensions[].rawInputs` — the independent-domain list, the age in
days, the matched signal names, the matched class rule — plus the weight and the
contribution. A reader can recompute any score with a calculator; the report prints the
breakdown for the top claims and the full data is in the ledger and in `--json`.

Class assignment is rule-driven too: `rubric/sourceClassRules.upgrade` is an ordered list
of host/path regexes. The matched rule id is stored on every source, so
`("nodejs.org/api/deprecations.html" -> primary_documentation, rule "official-docs-host")`
is auditable rather than asserted.

Changing the rubric is a data edit plus a version bump. `validateRubric` refuses to load a
rubric whose weights do not sum to 1.0 or whose conflict policy is not
`surface_never_average`.

### Conflicts

Two kinds are detected and both are recorded as first-class objects:

- **polarity** — one source asserts a predicate, another denies the same predicate
  (`"deprecated"` vs `"not deprecated"`). The candidate pair must negate the *same*
  predicate, so two sentences about the same topic but different claims are not dressed
  up as a disagreement.
- **value** — sources agree on the topic but report different versions, dates or ids.

Opposing claims are never combined into one number. The engine scores the two sides
separately, quotes both with their sources, marks the record `resolution: "not_averaged"`,
and carries the losing side into the report as dissent. Each material conflict also
reduces the confidence score, by a factor stated in the rubric.

### Confidence

Deterministic and computed by the engine, never asserted by the reasoner:

```
score = primaryGroupScore × coverageFactor × authorityFactor × retrievalFactor × (1 − conflictPenalty)
```

Every factor, and the raw input behind it (independent domain count, whether an
authoritative source is present, how many adapters answered, how many conflicts were
found), is stored in the ledger entry, so the number can be recomputed by hand. The rubric
maps the score to `high` / `moderate` / `low` / `very_low`.

## The evidence ledger

Append-only. One entry per run: run id and timestamp, question, every retrieval outcome and
its failure reason, every source (URL, retrieval path, class, matched rule, text hash), every
claim, every score with its rubric version and raw inputs, the verdict, the confidence with
its inputs, the dissent, and the provider configuration used.

Backends: a SQLite file (`aletheia-ledger.db` by default) and Postgres, used only when
`DATABASE_URL` is set. If Postgres cannot be opened the run falls back to the SQLite file
with a note — the ledger is never the reason a research run dies.

Three independent guarantees that past entries cannot change:

1. the interface has no update and no delete method at all;
2. database triggers reject `UPDATE` and `DELETE` on the entries table, so even a
   hand-written statement from a SQL shell fails;
3. each entry stores `sha256(prevHash + canonical-JSON body)`, chained to its predecessor,
   so a change made by any other means is detectable with `bun run research ledger verify`.

A correction is a new entry that supersedes the old one. The old entry stays.

## Configuration

Everything is optional. With an empty environment the engine runs end to end on the
key-free paths.

| variable | default | purpose |
| --- | --- | --- |
| `ALETHEIA_DB` | `aletheia-ledger.db` | SQLite ledger path |
| `DATABASE_URL` | unset | switches the ledger to Postgres |
| `ALETHEIA_RUBRIC` | `rubric/v1.json` | rubric file |
| `ALETHEIA_RETRIEVAL` | all adapters | comma-separated adapter ids |
| `ALETHEIA_TIMEOUT_MS` | `12000` | per-request timeout |
| `ALETHEIA_MAX_SOURCES` | `24` | cap on merged sources |
| `ALETHEIA_PER_ADAPTER_LIMIT` | `5` | cap on sources per adapter |
| `ALETHEIA_OFFLINE` | unset | `1` disables every network path |
| `ALETHEIA_NO_LEDGER` | unset | `1` skips the ledger |
| `ALETHEIA_USER_AGENT` | built-in | outbound User-Agent |
| `ALETHEIA_WEBSEARCH_BACKENDS` | `hn-algolia,marginalia` | web-search backends, in order |
| `ALETHEIA_REGISTRY_BACKENDS` | `npm,pypi,maven` | package registries |
| `ALETHEIA_MEDIAWIKI_API` | `https://en.wikipedia.org/w/api.php` | any MediaWiki API |
| `GITHUB_TOKEN` | unset | optional; raises GitHub rate limits |
| `STACKEXCHANGE_KEY`, `STACKEXCHANGE_SITE` | unset / `stackoverflow` | optional; raises the SE quota |
| `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`, `MOJEEK_API_KEY` | unset | activate the matching search backend |

There is no model variable to set: no configuration in this engine selects, contacts or
falls back to a language model.

Keys are read only at the point of use, never logged, never written to a `.env` file, and
the ledger records only *whether* a credential was present, never its value.

## Tests

```sh
bun test
```

42 tests, no network access and no credentials. They cover: rubric validity and refusal of
a broken rubric; source classification by rule; deterministic, byte-identical scoring
across repeated runs; every total equalling the weighted sum of its dimensions; recency
and corroboration arithmetic; conflict detection and the confidence penalty it applies;
confidence being a pure function of the recorded inputs; the ledger refusing `UPDATE` and
`DELETE` at the database level and through its interface; hash-chain verification
succeeding on an intact log and failing on a tampered one; corrections being new entries;
an adapter that throws, one that is rate-limited, one that times out and one that returns
nothing — each degrading the run without killing it; every adapter failing and the report
saying so; offline mode; a key-gated provider staying inert with an empty environment; the
full pipeline end to end against a local HTTP server; that the reasoning layer has exactly
one implementation and that no file under `src/` names a model path; and that the verdict
prose is byte-identical for identical evidence.

## Layout

```
src/
  cli.ts                  command line entry point
  pipeline.ts             retrieval → extract → cluster → score → conflict → confidence → verdict → ledger
  config.ts               environment parsing (the only place env is read wholesale)
  types.ts                every interface; no vendor named anywhere
  util/                   text normalisation, hashing, HTTP with classification
  retrieval/              six adapters + the registry that lists them
  reasoning/              the deterministic template reasoner (the only one)
  grade/                  rubric loading/validation, extraction, clustering, conflicts, confidence
  ledger/                 append-only SQLite and Postgres backends
  render/                 Markdown report and JSON report
rubric/v1.json            the rubric, as data
fixtures/sources.ts       hand-written source documents for the tests
tests/                    rubric, ledger, degradation and pipeline suites
demo-report.md            the recorded live demo run
```

## Deliberately out of scope (next cycles)

The dashboard UI, the automated outcome-verification and learning loop, and the
software-verification workflow itself.
