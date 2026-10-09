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
bun test                                                # 70 tests, no network, no keys
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

42 research tests, no network access and no credentials. They cover: rubric validity and refusal of
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

The browser layer adds its own suites (`tests/browser.test.ts`,
`tests/determinism.test.ts`) — a real browser against pages this repository authors
itself, never another team's fixture. They cover: pass, fail and error in one run and the
run continuing after an error; the coverage report and the UNVERIFIED rule; screenshots
and traces really existing on disk; one ledger entry per run in its own hash chain; both
drivers executing the same pack; a malformed pack being refused rather than guessed at;
and determinism — two runs of the same pack against the same application state producing
an identical outcome digest, on a run containing a failing and two erroring checks, with
the volatile text classes (durations, timestamps, temp paths, heap addresses, stack
frames) shown rewritten class by class, and the digest shown still changing when an
observation, an outcome or a requirement binding changes.

```sh
bun test tests/determinism.test.ts     # the determinism proof on its own
```

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
  browser/                the real-browser layer
    driver.ts             the driver interface; no driver is load-bearing
    playwright-driver.ts  Playwright + an already-installed Chromium
    cdp-driver.ts         raw DevTools Protocol over the runtime's own WebSocket
    registry.ts           driver selection, by configuration
    spec.ts               pack validation (a malformed pack is refused, not guessed at)
    runner.ts             one session and one artifact directory per check
    predicates.ts         the declarative expectations and what they observed
    expr.ts               the small deterministic arithmetic evaluator
    coverage.ts           the requirement coverage report and the UNVERIFIED rule
    digest.ts             the outcome digest: what is hashed, and what never is
    render.ts             the receipt, written for a non-developer
rubric/v1.json            the rubric, as data
checks/web-demo.json      the demo check pack (one check per requirement)
checks/web-demo-requirements.json   the requirement set it is graded against
fixtures/sources.ts       hand-written source documents for the tests
fixtures/web/             the demo application: three static pages + a local server
tests/                    rubric, ledger, degradation, pipeline, browser and determinism suites
demo-report.md            the recorded live demo run
```

## Deliberately out of scope (next cycles)

The dashboard UI, the automated outcome-verification and learning loop, and the
software-verification workflow itself.

---

# Real-browser verification (executed checks, captured evidence)

The engine can now make things happen in a real browser: open a URL, click,
type, read visible text and attributes, wait for a state, assert a condition,
capture a screenshot and record a session trace. Every claim a check makes is
tied to an executed action and a captured file.

No account, no key, no paid service, no metered call - and **no model anywhere**.
`tests/pipeline.test.ts` still scans every file under `src/` and fails if any
model or provider plumbing appears.

## What it needs (already on this machine; nothing was downloaded)

| Path | What it uses | Disk cost |
| --- | --- | --- |
| `playwright` driver (preferred) | the Playwright module already at `/usr/lib/node_modules/playwright` plus the Chromium already at `/opt/browsers/chromium-1248/...` (symlinked as `/usr/local/bin/chromium`) | **0 bytes added** - both were pre-installed, so no ~400 MB download |
| `cdp` driver (fallback) | the same Chromium binary, driven over the DevTools Protocol using the runtime's own WebSocket - no third-party package at all | **0 bytes added** |

Driver selection is configuration, not code: `--browser playwright|cdp|auto`
(or `ALETHEIA_BROWSER_DRIVER`). With `auto`, each available driver is tried in
turn and a driver that cannot start is recorded in the run's notes and skipped,
so no single implementation is load-bearing. A browser is looked up by
`ALETHEIA_BROWSER_EXECUTABLE` / `CHROME_PATH` first, then the standard locations,
then the browser directories Playwright-style installs use.

Uninstall either one and the layer still runs on the other. Remove both and the
run stops with a clear message instead of pretending.

**Honest limitation of the CDP driver:** it performs clicks and typing with
scripted DOM calls (`element.click()`, setting `value` and dispatching
`input`/`change`), not with synthesized OS-level input events the way Playwright
does. That is enough to drive a normal form, but a page that only reacts to
*trusted* events behaves differently there. Every trace event names the
mechanism it used, and the run's notes repeat the caveat, so a finding never
overstates what was done.

## Run a check pack against a running app

```bash
# 1. start the app under test (the demo pages this repo authors itself)
bun run demo:web                       # http://127.0.0.1:4287

# 2. run the pack - the one documented command
bun run verify:web
#    equivalently, and for any app:
bun run src/cli.ts browser run --pack checks/web-demo.json \
    --requirements checks/web-demo-requirements.json --base-url http://127.0.0.1:4287
```

### Exit codes

The runner exits non-zero as soon as anything is wrong, so a caller needs to be
able to tell **"it ran and found problems"** from **"it could not run"** — and
from **"it ran but something could not be executed"**, which is a different
thing again. These are the only codes `browser run` returns:

| code | what it means | exact condition |
| --- | --- | --- |
| `0` | ran, nothing to report | every selected check executed and passed, and no requirement was left UNVERIFIED |
| `1` | **ran and found problems** | at least one bound check FAILED, or at least one requirement was left UNVERIFIED (no check bound to it, or its check was filtered out by `--only`) |
| `3` | **ran, but not to completion** | at least one check could not be executed to completion (a step or an expectation ERRORED). A requirement with an ERRORED check is reported ERROR, never PASSED. Takes precedence over `1`, so a run that both failed and errored exits `3` — the coverage report and the receipt still carry both |
| `2` | **could not run** | nothing was verified: no `--pack`, an invalid or malformed pack, no base URL, no browser driver could be started, a bad flag, or an unexpected internal error. Nothing in the run record can be read as a verdict, because there is no run record |

A failing check is *not* an engine failure: a run that correctly demonstrates a
broken application is a successful verification of a broken application, which
is why that case is `1` and not `2`. `--json` prints the machine-readable run
record to stdout and does not change the exit code; progress notes go to stderr,
so `... --json --quiet | jq .outcome_digest` is a clean pipeline.

```sh
bun run verify:web; echo "exit=$?"   # 0, 1, 2 or 3 as above
```

(`bun run research ledger verify` is a separate command: it exits `1` when a
hash chain is broken and `0` when both chains are intact.)

Useful flags: `--only <ids>`, `--browser cdp`, `--no-trace`,
`--no-screenshots`, `--headful`, `--artifacts <dir>`, `--json`, `--quiet`,
`--no-ledger`, `--run-id <id>`.
`bun run browser-drivers` reports which drivers this machine can run and why.

## Where artifacts land

Default `artifacts/browser/<runId>/` next to the ledger:

```
artifacts/browser/verify-corner-shop-web-20261009T020329-8506b0/
  run.json                       the whole run record: outcomes, actions, reads, paths
  report.md                      the receipt, written for a non-developer
  coverage.json                  the requirement coverage report
  checks/<check-id>/final.png    the page as it was when the check concluded
  checks/<check-id>/03-<label>.png   any mid-check screenshot the pack asked for
  checks/<check-id>/trace.zip    Playwright trace (opens in `npx playwright show-trace`)
                                 or trace.jsonl for the CDP driver
```

Each check gets its own browser context, its own trace and its own directory, so
two checks can never contaminate each other's evidence.

## How a finding cites its evidence

Every check result carries the requirement id, the outcome
(`pass` / `fail` / `error`), the observed value, the expected value, a timestamp
and run id, and the artifact paths. Underneath, every EXECUTED ACTION is
recorded: the op, the selector as written in the pack, the CSS actually used, any
value typed, the URL at the time, the status and any error. Every value read out
of the page is recorded with the selector it came from and the URL it was on.

So a line in the receipt resolves to an executed action plus an image:

```json
{
  "check_id": "tax-is-8-5-percent-of-netted-subtotal",
  "requirement_id": "R5",
  "outcome": "pass",
  "observed": "6.89 (read from [data-testid=tax])",
  "expected": "pct(net, tax_rate) = 6.885 [net=81, tax_rate=8.5] (tolerance 0.01)",
  "actions": [{ "index": 1, "op": "navigate", "url": "...", "status": "ok" }, ...],
  "reads": [{ "name": "net", "value": 81, "url": "http://127.0.0.1:4287/cart.html" }],
  "artifacts": { "screenshot": "checks/.../final.png", "trace": "checks/.../trace.zip" }
}
```

One ledger entry per run is appended to the append-only evidence ledger
(`ledger.verifications` / `ledger.show-verification <runId>`), referencing the
artifact directory. Verification runs live in their own hash-chained stream next
to research runs - same file, same append-only guarantees, separate chain -
because a verification entry records executed checks, which is not the shape of a
graded research answer. `bun run verify-ledger` checks both chains.

## How to author a check (data, not code)

A pack is JSON: `spec_version`, `pack_id`, `pack_version`, `base_url`,
`selectors` (name -> CSS), optional `requirements`, and `checks`. Every check
declares an `id`, the **`requirement_id` it is bound to**, a plain-language
`description`, and ordered `steps`. A pack that omits a binding, references a
selector that is neither declared nor recognisably CSS, or contains a broken
formula is refused when it loads - a typo that silently checks nothing is the
exact failure this system exists to prevent.

```json
{
  "id": "tax-is-8-5-percent-of-netted-subtotal",
  "requirement_id": "R5",
  "description": "Tax is 8.5% of the subtotal after discount.",
  "steps": [
    { "op": "navigate", "path": "/cart.html" },
    { "op": "type", "selector": "discountCode", "text": "SAVE10" },
    { "op": "click", "selector": "applyDiscount" },
    { "op": "wait_for_text", "selector": "net", "text": "$81.00" },
    { "op": "expect", "expect": {
        "kind": "value_equals",
        "actual": { "selector": "tax", "as": "number", "strip": "[^0-9.]" },
        "expected": { "expr": "pct(net, tax_rate)", "vars": {
            "net": { "selector": "net", "as": "number", "strip": "[^0-9.]" },
            "tax_rate": { "selector": "taxRate", "from": "attribute", "attribute": "data-rate", "as": "number" } } },
        "tolerance": 0.01,
        "message": "tax must be 8.5% of the discounted subtotal" } }
  ]
}
```

Steps: `navigate`, `click`, `type`, `wait_for`, `wait_for_text`, `read`,
`read_many`, `expect`, `screenshot`, `note`.

Expectations: `text_present`, `text_absent`, `element_visible`,
`element_hidden`, `count_equals`, `attribute_equals`, `value_equals`,
`value_in_range`, `cross_page_agrees` (compares the same value read on two
different pages, and reports an ERROR if both reads happened on one page, because
then the check did not verify what it claims), `list_order`
(`sequence` / `ascending` / `descending`), `list_membership`, `url_matches`.

Values are compared against a literal (`{"value": 87.89}`), a value read earlier
(`{"var": "cartTotal"}`), or **arithmetic recomputed from the page's own
numbers**: `{"expr": "pct(subtotal - discount, tax_rate)", "vars": { ... }}`.
The expression language is a small deterministic evaluator (`+ - * / % ^`,
parentheses, `pct`, `round`, `floor`, `ceil`, `abs`, `min`, `max`, `sum`,
`scale`). A pack never ships JavaScript for the engine to evaluate, which is what
keeps "same inputs, same verdict" true.

## Coverage honesty

The coverage report lists every requirement in the set with the checks bound to
it and its state. **A requirement is PASSED only where a bound check actually
executed and passed.** No check, or a check filtered out by `--only`, or a check
that could not run: `UNVERIFIED`. A check that failed: `FAILED`. A check that
could not execute to completion: `ERROR`, never `PASSED`. The report says this in
its own words under `honesty`, so the file cannot be read as claiming more than
was demonstrated.

## Determinism of the outcome digest

Every run records an `outcome_digest`: a sha256 over **what was observed**. The
claim it makes is narrow and checkable — *same check pack, same application
state, same digest* — so it is worth being precise about what goes into it.
`digestProjection()` (`src/browser/digest.ts`) returns the exact structure that
is hashed, and `bun test tests/determinism.test.ts` prints the proof:

```sh
bun run verify:web                       # exit 1 or 3 here: the app really is faulty
bun run verify:web                       # same pack, same app state
# compare the two `outcome digest:` lines
```

**Absent from the digest, by construction** — not masked, never hashed: every
measured duration (`duration_ms`, action timings), every wall-clock timestamp
(`started_at`, `finished_at`, read timestamps), the run id, the driver, the
artifact paths and the artifact counts. Those all stay in `run.json`, where a
measurement is evidence rather than identity.

**Normalised before hashing**, because they are written by something other than
this engine and vary run to run:

| class | example | becomes |
| --- | --- | --- |
| measured durations | `Timeout 400ms exceeded`, `took 1.20s` | `<duration>` |
| ISO-8601 timestamps | `2026-02-03T04:05:06.000Z` | `<timestamp>` |
| `Date.toString()` timestamps | `Mon Feb 03 2026 04:05:06 GMT+0000 (…)` | `<timestamp>` |
| bare clock times | `11:22:33` | `<time>` |
| temporary paths | `/tmp/aletheia-cdp-L8Xq2p/Default` | `<temp-path>` |
| heap / object addresses | `0x7ffd4a1b2c30` | `<address>` |
| stack-frame coordinates | `app.js:42:17` | `<frame>` |
| the origin the app was served on | `http://127.0.0.1:4287/cart.html` | `<origin>/cart.html` |

Normalisation is applied to the fields **this engine wrote about the run**
(`detail`, `error.message`, the per-action error) and to URLs and action values.
It is deliberately *not* applied to `observed`, to `expected`, or to the values
read out of the page: those are the evidence, and two runs whose observations
differed did not observe the same thing.

That boundary has one consequence worth stating plainly, because it is the one
case where a digest will differ between two runs that both "passed":
**an application that renders a clock (or any other run-varying text) into a
value a check reads will produce a different digest on every run, and that is
the honest answer** — the observed evidence really did differ. The digest
refuses to call two different observations the same. What it will not do is let
a *timer* inside the engine change the verdict of an otherwise identical run;
the drivers word a timeout from the configured timeout and from what the error
says, never from a measured elapsed time, which is what previously made an
identical run word its message two different ways.

The proof in `tests/determinism.test.ts` runs the same pack twice with the
**real clock** (nothing stubbed) against the same application state, on a run
containing one passing, one **failing** and two **erroring** checks (one whose
step cannot be executed, one whose expectation cannot be evaluated), and shows:

1. the two run records genuinely differ — different run ids, timestamps,
   durations and artifact directories — **and** the two outcome digests are
   byte-identical;
2. a third run of the same state served on a **different port** produces the
   same digest again, so the digest does not depend on where the app was served;
3. the digest is still sensitive: changing an observed value, an outcome, or a
   requirement binding changes it, and page text that merely *looks* like a
   timestamp is not collapsed;
4. each volatile class above is rewritten to its marker, with the duration the
   driver actually wrote still present verbatim in `run.json`.
