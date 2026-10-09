# Aletheia research report

**Question.** Is the built-in punycode module deprecated in Node.js, and what should replace it? Is the npm punycode package also deprecated?

`run id a7589f83-3828-45a7-b053-f75110e4bb61`  ·  `2026-10-09T01:42:39.027Z`  ·  rubric `aletheia-rubric@1.0.0` (sha256 `d851a304529c13d5…`)  ·  engine `0.1.0`

## Verdict

**The evidence supports: Hello .ksvirkou-hubspot Using Node.js lts/jod: The punycode module was deprecated some time ago: https://nodejs.org/api/deprecations.html#DEP0040 Steps to Reproduce: Install and use the HubSpot Node.js API Client in a project.**

### What the evidence establishes (for the proposition)

- Hello .ksvirkou-hubspot Using Node.js lts/jod: The punycode module was deprecated some time ago: https://nodejs.org/api/deprecations.html#DEP0040 Steps to Reproduce: Install and use the HubSpot Node.js API Client in a project. [S13] _(score 0.7119, primary documentation)_

### Stated replacement or mitigation

- At any variation of import I use I get lots of warnings on the console of the npm start, and on browser console I get TypeError: Cannot read property 'map' of null at my-component.js:13771 "http://localhost:3333/build/mycomponent/my-component.js" .mycomponent.core.js:2193 npm start console: [52:27.1] generate styles finished in 974 ms preferring built-in... [S19]
- Hello .ksvirkou-hubspot Using Node.js lts/jod: The punycode module was deprecated some time ago: https://nodejs.org/api/deprecations.html#DEP0040 Steps to Reproduce: Install and use the HubSpot Node.js API Client in a project. [S13]
- Root Cause Node.js 22.x LTS deprecates the built-in punycode module Some internal Node.js operations still use it This is a Node.js internal issue, not a project issue Status EXPECTED BEHAVIOR - This warning is normal and harmless Why It's Not a Problem 1. [S10]

### Per-part answer

- **Is the built-in punycode module deprecated in Node.js, and what should replace it** - Root Cause Node.js 22.x LTS deprecates the built-in punycode module Some internal Node.js operations still use it This is a Node.js internal issue, not a project issue Status EXPECTED BEHAVIOR - This warning is normal and harmless Why It's Not a Problem 1. [S10] _(rated 0.6738)_
- **Is the npm punycode package also deprecated** - For example, require('punycode') still imports the deprecated core module even if you executed npm install punycode . [S3] _(rated 0.4225)_

### Dissent and conflicts

- **Direct contradiction** (`X1`, cluster `K10`, material): 0.9..7, 6.0..0, 7.0..0, alia, api, class, crypto.createcredentials, crypto.credentials, cryptostream.prototype.readystate, deprecat, domain.dispose, end-of-life
  - Side A (nodejs.org): Type: End-of-Life OutgoingMessage.prototype.flush() has been removed.
  - Side B (github.com): Node.js 22 still supports punycode (deprecated, not removed) 3.
  - Not averaged: Independent sources take opposite positions on the predicate "deprecat" (asserted by nodejs.org using "deprecat", denied by github.com using "not removed"). Both sides are reported; the engine does not average them.

### Confidence: low (0.4385)

`score = primaryGroupScore x coverageFactor x authorityFactor x retrievalFactor x (1 - conflictPenalty)`

primary group score 0.7119; coverage 0.7 (1 independent domain(s)); authority 1 (authoritative source present); retrieval 1 (6/6 adapters answered); conflict penalty 0.12 (1 material, 0 minor); => 0.4385 (low)

Computed by the engine from the rubric, not asserted by the reasoner. Inputs are recorded in the ledger so this number can be recomputed by hand.

## Confidence: low (`0.4385`)

```
score = primaryGroupScore x coverageFactor x authorityFactor x retrievalFactor x (1 - conflictPenalty)
primary group score 0.7119; coverage 0.7 (1 independent domain(s)); authority 1 (authoritative source present); retrieval 1 (6/6 adapters answered); conflict penalty 0.12 (1 material, 0 minor); => 0.4385 (low)
```

| Confidence input | Value |
| --- | --- |
| `primaryGroupScore` | 0.7119 |
| `secondaryGroupScore` | 0.6738 |
| `independentDomainCount` | 1 |
| `coverageFactor` | 0.7 |
| `authoritativeSourcePresent` | true |
| `authorityFactor` | 1 |
| `conflictsMaterial` | 1 |
| `conflictsMinor` | 0 |
| `conflictPenalty` | 0.12 |
| `adaptersAvailable` | 6 |
| `adaptersTotal` | 6 |
| `retrievalFactor` | 1 |
| `supportingClaimCount` | 1 |
| `sourcesByClass` | {"primary_documentation":12,"unknown":4,"first_party_changelog":2,"qa_forum":5,"aggregator":1} |

## Dissent, conflicts and gaps

- **conflict** — Direct contradiction on cluster K10: 0.9..7, 6.0..0, 7.0..0, alia, api, class, crypto.createcredentials, crypto.credentials, cryptostream.prototype.readystate, deprecat, domain.dispose, end-of-life. Not averaged. _(sources: nodejs.org, github.com)_
- **weak evidence** — Confidence is low (0.4385). Treat the position above as provisional.

## Conflicts (surfaced, never averaged)

### X1 — direct contradiction (material)

Topic: 0.9..7, 6.0..0, 7.0..0, alia, api, class, crypto.createcredentials, crypto.credentials, cryptostream.prototype.readystate, deprecat, domain.dispose, end-of-life

- **Side A** (nodejs.org) — claims S1-C10, S1-C14, S1-C16, S1-C41, S1-C43, S1-C45, S1-C54, S1-C56, S1-C64, S1-C67, S1-C70, S1-C72, S1-C75, S1-C79, S1-C81, S1-C83, S1-C85, S1-C87, S1-C111, S1-C113, S1-C115, S1-C119, S1-C121, S1-C123, S1-C126, S1-C128, S1-C130, S1-C132, S1-C134, S1-C136
  - `S1` (primary documentation): Type: End-of-Life OutgoingMessage.prototype.flush() has been removed.
  - `S1` (primary documentation): Type: End-of-Life The writableState.buffer has been removed.
  - `S1` (primary documentation): Type: End-of-Life The CryptoStream.prototype.readyState property was removed.
- **Side B** (github.com) — claims S10-C6
  - `S10` (primary documentation): Node.js 22 still supports punycode (deprecated, not removed) 3.

_Resolution policy: `not_averaged` — Independent sources take opposite positions on the predicate "deprecat" (asserted by nodejs.org using "deprecat", denied by github.com using "not removed"). Both sides are reported; the engine does not average them._

## Scoring appendix (recompute by hand)

Total = Σ (dimension weight × dimension score), rounded to 4 dp. Rubric `aletheia-rubric@1.0.0`; the file is stored with the code so every weight below is checkable.

| claim | source | class | total | sourceClass | corroboration | recency | specificity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `S1-C9` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C11` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C13` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C15` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C17` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C27` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C29` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C33` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C36` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C40` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C42` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |
| `S1-C44` | `S1` | primary documentation | **0.7322** | 0.9 (w0.35) | 0.35 (w0.25) | 0.9983 (w0.2) | 0.65 (w0.2) |

<details><summary>Raw inputs behind the top 5 scores</summary>

**`S1-C9`** — total `0.7322`

- `sourceClass` score `0.9` × weight `0.35` = `0.315` — sourceClass "primary_documentation" (rule official-docs-host) -> scale[primary_documentation] = 0.9
  - inputs: `{"sourceClass":"primary_documentation","ruleId":"official-docs-host","matchedScaleKey":"primary_documentation","scale":{"standards_spec":1,"primary_documentation":0.9,"first_party_changelog":0.8,"vendor_blog":0.6,"qa_forum":0.4,"aggregator":0.3,"unknown":0.2}}`
- `corroboration` score `0.35` × weight `0.25` = `0.0875` — 1 independent domain(s) asserting the same proposition -> 0.35 (step curve)
  - inputs: `{"independentDomains":["nodejs.org"],"allDomains":["nodejs.org"],"count":1,"points":[{"domains":0,"score":0},{"domains":1,"score":0.35},{"domains":2,"score":0.7},{"domains":3,"score":0.9},{"domains":4,"score":1}],"above":1}`
- `recency` score `0.9983` × weight `0.2` = `0.1997` — age 1.36d, half-life 540d -> max(0.1, 0.5^(1.36/540)) = 0.9983
  - inputs: `{"publishedAt":"2026-10-07T16:57:53.000Z","dateSource":"source_metadata","runDate":"2026-10-09T01:42:39.027Z","ageDays":1.36,"halfLifeDays":540,"floor":0.1}`
- `specificity` score `0.65` × weight `0.2` = `0.13` — signals [identifierToken, numericToken, versionToken] -> min(cap, 0.65) = 0.65
  - inputs: `{"matchedSignals":["identifierToken","numericToken","versionToken"],"signalWeights":{"versionToken":0.3,"identifierToken":0.25,"dateToken":0.2,"urlToken":0.15,"numericToken":0.1},"cap":1}`

**`S1-C11`** — total `0.7322`

- `sourceClass` score `0.9` × weight `0.35` = `0.315` — sourceClass "primary_documentation" (rule official-docs-host) -> scale[primary_documentation] = 0.9
  - inputs: `{"sourceClass":"primary_documentation","ruleId":"official-docs-host","matchedScaleKey":"primary_documentation","scale":{"standards_spec":1,"primary_documentation":0.9,"first_party_changelog":0.8,"vendor_blog":0.6,"qa_forum":0.4,"aggregator":0.3,"unknown":0.2}}`
- `corroboration` score `0.35` × weight `0.25` = `0.0875` — 1 independent domain(s) asserting the same proposition -> 0.35 (step curve)
  - inputs: `{"independentDomains":["nodejs.org"],"allDomains":["nodejs.org"],"count":1,"points":[{"domains":0,"score":0},{"domains":1,"score":0.35},{"domains":2,"score":0.7},{"domains":3,"score":0.9},{"domains":4,"score":1}],"above":1}`
- `recency` score `0.9983` × weight `0.2` = `0.1997` — age 1.36d, half-life 540d -> max(0.1, 0.5^(1.36/540)) = 0.9983
  - inputs: `{"publishedAt":"2026-10-07T16:57:53.000Z","dateSource":"source_metadata","runDate":"2026-10-09T01:42:39.027Z","ageDays":1.36,"halfLifeDays":540,"floor":0.1}`
- `specificity` score `0.65` × weight `0.2` = `0.13` — signals [identifierToken, numericToken, versionToken] -> min(cap, 0.65) = 0.65
  - inputs: `{"matchedSignals":["identifierToken","numericToken","versionToken"],"signalWeights":{"versionToken":0.3,"identifierToken":0.25,"dateToken":0.2,"urlToken":0.15,"numericToken":0.1},"cap":1}`

**`S1-C13`** — total `0.7322`

- `sourceClass` score `0.9` × weight `0.35` = `0.315` — sourceClass "primary_documentation" (rule official-docs-host) -> scale[primary_documentation] = 0.9
  - inputs: `{"sourceClass":"primary_documentation","ruleId":"official-docs-host","matchedScaleKey":"primary_documentation","scale":{"standards_spec":1,"primary_documentation":0.9,"first_party_changelog":0.8,"vendor_blog":0.6,"qa_forum":0.4,"aggregator":0.3,"unknown":0.2}}`
- `corroboration` score `0.35` × weight `0.25` = `0.0875` — 1 independent domain(s) asserting the same proposition -> 0.35 (step curve)
  - inputs: `{"independentDomains":["nodejs.org"],"allDomains":["nodejs.org"],"count":1,"points":[{"domains":0,"score":0},{"domains":1,"score":0.35},{"domains":2,"score":0.7},{"domains":3,"score":0.9},{"domains":4,"score":1}],"above":1}`
- `recency` score `0.9983` × weight `0.2` = `0.1997` — age 1.36d, half-life 540d -> max(0.1, 0.5^(1.36/540)) = 0.9983
  - inputs: `{"publishedAt":"2026-10-07T16:57:53.000Z","dateSource":"source_metadata","runDate":"2026-10-09T01:42:39.027Z","ageDays":1.36,"halfLifeDays":540,"floor":0.1}`
- `specificity` score `0.65` × weight `0.2` = `0.13` — signals [identifierToken, numericToken, versionToken] -> min(cap, 0.65) = 0.65
  - inputs: `{"matchedSignals":["identifierToken","numericToken","versionToken"],"signalWeights":{"versionToken":0.3,"identifierToken":0.25,"dateToken":0.2,"urlToken":0.15,"numericToken":0.1},"cap":1}`

**`S1-C15`** — total `0.7322`

- `sourceClass` score `0.9` × weight `0.35` = `0.315` — sourceClass "primary_documentation" (rule official-docs-host) -> scale[primary_documentation] = 0.9
  - inputs: `{"sourceClass":"primary_documentation","ruleId":"official-docs-host","matchedScaleKey":"primary_documentation","scale":{"standards_spec":1,"primary_documentation":0.9,"first_party_changelog":0.8,"vendor_blog":0.6,"qa_forum":0.4,"aggregator":0.3,"unknown":0.2}}`
- `corroboration` score `0.35` × weight `0.25` = `0.0875` — 1 independent domain(s) asserting the same proposition -> 0.35 (step curve)
  - inputs: `{"independentDomains":["nodejs.org"],"allDomains":["nodejs.org"],"count":1,"points":[{"domains":0,"score":0},{"domains":1,"score":0.35},{"domains":2,"score":0.7},{"domains":3,"score":0.9},{"domains":4,"score":1}],"above":1}`
- `recency` score `0.9983` × weight `0.2` = `0.1997` — age 1.36d, half-life 540d -> max(0.1, 0.5^(1.36/540)) = 0.9983
  - inputs: `{"publishedAt":"2026-10-07T16:57:53.000Z","dateSource":"source_metadata","runDate":"2026-10-09T01:42:39.027Z","ageDays":1.36,"halfLifeDays":540,"floor":0.1}`
- `specificity` score `0.65` × weight `0.2` = `0.13` — signals [identifierToken, numericToken, versionToken] -> min(cap, 0.65) = 0.65
  - inputs: `{"matchedSignals":["identifierToken","numericToken","versionToken"],"signalWeights":{"versionToken":0.3,"identifierToken":0.25,"dateToken":0.2,"urlToken":0.15,"numericToken":0.1},"cap":1}`

**`S1-C17`** — total `0.7322`

- `sourceClass` score `0.9` × weight `0.35` = `0.315` — sourceClass "primary_documentation" (rule official-docs-host) -> scale[primary_documentation] = 0.9
  - inputs: `{"sourceClass":"primary_documentation","ruleId":"official-docs-host","matchedScaleKey":"primary_documentation","scale":{"standards_spec":1,"primary_documentation":0.9,"first_party_changelog":0.8,"vendor_blog":0.6,"qa_forum":0.4,"aggregator":0.3,"unknown":0.2}}`
- `corroboration` score `0.35` × weight `0.25` = `0.0875` — 1 independent domain(s) asserting the same proposition -> 0.35 (step curve)
  - inputs: `{"independentDomains":["nodejs.org"],"allDomains":["nodejs.org"],"count":1,"points":[{"domains":0,"score":0},{"domains":1,"score":0.35},{"domains":2,"score":0.7},{"domains":3,"score":0.9},{"domains":4,"score":1}],"above":1}`
- `recency` score `0.9983` × weight `0.2` = `0.1997` — age 1.36d, half-life 540d -> max(0.1, 0.5^(1.36/540)) = 0.9983
  - inputs: `{"publishedAt":"2026-10-07T16:57:53.000Z","dateSource":"source_metadata","runDate":"2026-10-09T01:42:39.027Z","ageDays":1.36,"halfLifeDays":540,"floor":0.1}`
- `specificity` score `0.65` × weight `0.2` = `0.13` — signals [identifierToken, numericToken, versionToken] -> min(cap, 0.65) = 0.65
  - inputs: `{"matchedSignals":["identifierToken","numericToken","versionToken"],"signalWeights":{"versionToken":0.3,"identifierToken":0.25,"dateToken":0.2,"urlToken":0.15,"numericToken":0.1},"cap":1}`

</details>

## Retrieval paths

| adapter | status | sources | note |
| --- | --- | --- | --- |
| `direct-url` | ok | 1 | — |
| `web-search` | partial | 3 | 2 page fetch failure(s); hn-algolia: 5 candidate URL(s) for query "punycode"; marginalia: 3 candidate URL(s) for query "punycode built-in node.js" |
| `package-registry` | ok | 4 | — |
| `code-host` | ok | 7 | — |
| `qa-forum` | ok | 5 | — |
| `reference-docs` | partial | 5 | mdn: 3 document(s) for "punycode built-in node.js"; mediawiki: 2 page(s) for "punycode" |

Paths that did not contribute cleanly: `web-search`, `reference-docs`. The run completed on the paths that answered.

## Sources

| id | class | path | published | url |
| --- | --- | --- | --- | --- |
| `S1` | primary documentation (`official-docs-host`) | direct-url/http-get | 2026-10-07 | https://nodejs.org/api/deprecations.html |
| `S2` | unknown (`default`) | web-search/hn-algolia | 2022-11-02 | https://words.filippo.io/dispatches/openssl-punycode/ |
| `S3` | primary documentation (`vcs-host`) | web-search/hn-algolia | 2011-11-22 | https://github.com/bestiejs/punycode.js |
| `S4` | unknown (`default`) | web-search/hn-algolia | 2026-10-07 | https://www.iankduncan.com/engineering/2025-12-01-punycode/ |
| `S5` | unknown (`default`) | package-registry/npm | 2023-10-30 | https://registry.npmjs.org/punycode |
| `S6` | unknown (`default`) | package-registry/npm | 2020-03-12 | https://registry.npmjs.org/node.js |
| `S7` | primary documentation (`registry-host`) | package-registry/pypi | unknown (unknown) | https://pypi.org/project/punycode/ |
| `S8` | primary documentation (`registry-host`) | package-registry/maven | unknown (unknown) | https://search.maven.org/search?q=punycode |
| `S9` | primary documentation (`vcs-host`) | code-host/github-issues | 2026-10-01 | https://github.com/layer5io/layer5/pull/8150 |
| `S10` | primary documentation (`vcs-host`) | code-host/github-issues | 2026-08-13 | https://github.com/hanbini96/HanBin-Baik-Blog/issues/96 |
| `S11` | primary documentation (`vcs-host`) | code-host/github-issues | 2026-07-25 | https://github.com/nickna/SharpTS/issues/1282 |
| `S12` | primary documentation (`vcs-host`) | code-host/github-issues | 2026-08-10 | https://github.com/r0adkll/upload-google-play/issues/265 |
| `S13` | primary documentation (`vcs-host`) | code-host/github-issues | 2026-06-01 | https://github.com/HubSpot/hubspot-api-nodejs/issues/565 |
| `S14` | first party changelog (`changelog-path`) | code-host/github-releases | 2023-10-30 | https://github.com/mathiasbynens/punycode.js/releases/tag/v2.3.1 |
| `S15` | first party changelog (`changelog-path`) | code-host/github-releases | 2023-12-19 | https://github.com/mathiasbynens/punycode.js/releases/tag/v2.3.0 |
| `S16` | qa forum (`qa-host`) | qa-forum/stackexchange | 2022-11-14 | https://stackoverflow.com/questions/74435438/like-search-in-punycode-values-in-postgresql |
| `S17` | qa forum (`qa-host`) | qa-forum/stackexchange | 2016-05-02 | https://stackoverflow.com/questions/36978428/excel-vba-punycode-support-for-international-domain-names-idna2003-idna2008-a |
| `S18` | qa forum (`qa-host`) | qa-forum/stackexchange | 2017-09-12 | https://stackoverflow.com/questions/46167812/why-does-webpack-build-of-react-web-app-fail-when-project-is-built-in-a-differen |
| `S19` | qa forum (`qa-host`) | qa-forum/stackexchange | 2018-08-23 | https://stackoverflow.com/questions/51988318/problems-importing-some-external-js-to-a-stenciljs-web-component |
| `S20` | qa forum (`qa-host`) | qa-forum/stackexchange | 2017-01-05 | https://stackoverflow.com/questions/41495596/rollup-js-unresolved-dependencies |
| `S21` | primary documentation (`official-docs-host`) | reference-docs/mdn | unknown (unknown) | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects |
| `S22` | primary documentation (`official-docs-host`) | reference-docs/mdn | unknown (unknown) | https://developer.mozilla.org/en-US/docs/Glossary/Node.js |
| `S23` | primary documentation (`official-docs-host`) | reference-docs/mdn | unknown (unknown) | https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Server-side/Node_server_without_framework |
| `S24` | aggregator (`aggregator-host`) | reference-docs/mediawiki | 2026-09-04 | https://en.wikipedia.org/wiki/Punycode |

## Extracted claims

| claim | source | polarity | overlap | text |
| --- | --- | --- | --- | --- |
| `S1-C1` | `S1` | assert | 0.125 | Node.js uses four kinds of deprecations: Documentation-only Application (non- nodemodules code only) Runtime (all code) End-of-Life A Documentation-only deprecation is one that is expressed only within the Node.js API... |
| `S1-C2` | `S1` | assert | 0.125 | These generate no side-effects while running Node.js. |
| `S1-C3` | `S1` | assert | 0 | Some Documentation-only deprecations trigger a runtime warning when launched with --pending-deprecation flag (or its alternative, NODEPENDINGDEPRECATION=1 environment variable), similarly to Runtime deprecations below. |
| `S1-C4` | `S1` | assert | 0.125 | Documentation-only deprecations that support that flag are explicitly labeled as such in the list of Deprecated APIs . |
| `S1-C5` | `S1` | assert | 0.125 | An Application deprecation for only non- nodemodules code will, by default, generate a process warning that will be printed to stderr the first time the deprecated API is used in code that's not loaded from nodemodules . |
| `S1-C6` | `S1` | assert | 0 | When the --throw-deprecation command-line flag is used, a Runtime deprecation will cause an error to be thrown. |
| `S1-C7` | `S1` | assert | 0 | When pending-deprecation is used, warnings will also be emitted for code loaded from nodemodules . |
| `S1-C8` | `S1` | assert | 0.125 | An End-of-Life deprecation is used when functionality is or will soon be removed from Node.js. |
| `S1-C9` | `S1` | assert | 0.125 | List of deprecated APIs # DEP0001: http.OutgoingMessage.prototype.flush # History Version Changes v14.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v1.6.0 Runtime deprecation. |
| `S1-C10` | `S1` | assert | 0 | Type: End-of-Life OutgoingMessage.prototype.flush() has been removed. |
| `S1-C11` | `S1` | assert | 0 | DEP0002: require('linklist') # History Version Changes v8.0.0 End-of-Life. v6.12.0 A deprecation code has been assigned. v5.0.0 Runtime deprecation. |
| `S1-C12` | `S1` | assert | 0.25 | Type: End-of-Life The linklist module is deprecated. |
| `S1-C13` | `S1` | assert | 0 | DEP0003: writableState.buffer # History Version Changes v14.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v0.11.15 Runtime deprecation. |
| `S1-C14` | `S1` | assert | 0 | Type: End-of-Life The writableState.buffer has been removed. |
| `S1-C15` | `S1` | assert | 0 | DEP0004: CryptoStream.prototype.readyState # History Version Changes v10.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v0.4.0 Documentation-only deprecation. |
| `S1-C16` | `S1` | assert | 0 | Type: End-of-Life The CryptoStream.prototype.readyState property was removed. |
| `S1-C17` | `S1` | assert | 0 | DEP0005: Buffer() constructor # History Version Changes v10.0.0 Runtime deprecation. v6.12.0 A deprecation code has been assigned. v6.0.0 Documentation-only deprecation. |
| `S1-C18` | `S1` | assert | 0.125 | Type: Application (non- nodemodules code only) The Buffer() function and new Buffer() constructor are deprecated due to API usability issues that can lead to accidental security issues. |
| `S1-C19` | `S1` | assert | 0 | As an alternative, use one of the following methods of constructing Buffer objects: Buffer.alloc(size[, fill[, encoding]]) : Create a Buffer with initialized memory. |
| `S1-C20` | `S1` | assert | 0 | Buffer.allocUnsafe(size) : Create a Buffer with uninitialized memory. |
| `S1-C21` | `S1` | assert | 0 | Buffer.allocUnsafeSlow(size) : Create a Buffer with uninitialized memory. |
| `S1-C22` | `S1` | assert | 0 | Buffer.from(array) : Create a Buffer with a copy of array Buffer.from(arrayBuffer[, byteOffset[, length]]) - Create a Buffer that wraps the given arrayBuffer . |
| `S1-C23` | `S1` | assert | 0 | Buffer.from(buffer) : Create a Buffer that copies buffer . |
| `S1-C24` | `S1` | assert | 0 | Buffer.from(string[, encoding]) : Create a Buffer that copies string . |
| `S1-C25` | `S1` | assert | 0 | Without --pending-deprecation , runtime warnings occur only for code not in nodemodules . |
| `S1-C26` | `S1` | assert | 0 | With --pending-deprecation , a runtime warning results no matter where the Buffer() usage occurs. |
| `S1-C27` | `S1` | assert | 0 | DEP0006: childprocess options.customFds # History Version Changes v12.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v0.11.14 Runtime deprecation. v0.5.10 Documentation-only deprecation. |
| `S1-C28` | `S1` | assert | 0.25 | Type: End-of-Life Within the childprocess module's spawn() , fork() , and exec() methods, the options.customFds option is deprecated. |
| `S1-C29` | `S1` | assert | 0.125 | DEP0007: Replace cluster worker.suicide with worker.exitedAfterDisconnect # History Version Changes v9.0.0 End-of-Life. v7.0.0 Runtime deprecation. v6.12.0 A deprecation code has been assigned. v6.0.0 Documentation-on... |
| `S1-C30` | `S1` | assert | 0.125 | Type: End-of-Life In an earlier version of the Node.js cluster , a boolean property with the name suicide was added to the Worker object. |
| `S1-C31` | `S1` | assert | 0.25 | In Node.js 6.0..0, the old property was deprecated and replaced with a new worker.exitedAfterDisconnect property. |
| `S1-C32` | `S1` | assert | 0 | The old property name did not precisely describe the actual semantics and was unnecessarily emotion-laden. |
| `S1-C33` | `S1` | assert | 0 | DEP0008: require('node:constants') # History Version Changes v6.12.0 A deprecation code has been assigned. v6.3.0 Documentation-only deprecation. |
| `S1-C34` | `S1` | assert | 0.25 | Type: Documentation-only The node:constants module is deprecated. |
| `S1-C35` | `S1` | assert | 0.25 | When requiring access to constants relevant to specific Node.js builtin modules, developers should instead refer to the constants property exposed by the relevant module. |
| `S1-C36` | `S1` | assert | 0 | DEP0009: crypto.pbkdf2 without digest # History Version Changes v14.0.0 End-of-Life (for digest === null ). v11.0.0 Runtime deprecation (for digest === null ). v8.0.0 End-of-Life (for digest === undefined ). v6.12.0 A... |
| `S1-C37` | `S1` | deny (without ... deprecat) | 0.25 | Type: End-of-Life Use of the crypto.pbkdf2() API without specifying a digest was deprecated in Node.js 6.0 because the method defaulted to using the non-recommended 'SHA1' digest. |
| `S1-C38` | `S1` | assert | 0.125 | Starting in Node.js 8.0..0, calling crypto.pbkdf2() or crypto.pbkdf2Sync() with digest set to undefined will throw a TypeError . |
| `S1-C39` | `S1` | assert | 0.125 | Beginning in Node.js 11.0..0, calling these functions with digest set to null would print a deprecation warning to align with the behavior when digest is undefined . |
| `S1-C40` | `S1` | assert | 0 | DEP0010: crypto.createCredentials # History Version Changes v11.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v0.11.13 Runtime deprecation. |
| `S1-C41` | `S1` | assert | 0 | Type: End-of-Life The crypto.createCredentials() API was removed. |
| `S1-C42` | `S1` | assert | 0 | DEP0011: crypto.Credentials # History Version Changes v11.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v0.11.13 Runtime deprecation. |
| `S1-C43` | `S1` | assert | 0 | Type: End-of-Life The crypto.Credentials class was removed. |
| `S1-C44` | `S1` | assert | 0 | DEP0012: Domain.dispose # History Version Changes v9.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v0.11.7 Runtime deprecation. |
| `S1-C45` | `S1` | assert | 0 | Type: End-of-Life Domain.dispose() has been removed. |
| `S1-C46` | `S1` | assert | 0 | DEP0013: fs asynchronous function without callback # History Version Changes v10.0.0 End-of-Life. v7.0.0 Runtime deprecation. |
| `S1-C47` | `S1` | assert | 0.125 | Type: End-of-Life Calling an asynchronous function without a callback throws a TypeError in Node.js 10.0..0 onwards. |
| `S1-C48` | `S1` | assert | 0 | See https://github.com/nodejs/node/pull/12562 . |
| `S1-C49` | `S1` | assert | 0 | DEP0014: fs.read legacy String interface # History Version Changes v8.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v6.0.0 Runtime deprecation. v0.1.96 Documentation-only deprecation. |
| `S1-C50` | `S1` | assert | 0.125 | Type: End-of-Life The fs.read() legacy String interface is deprecated. |
| `S1-C51` | `S1` | assert | 0 | DEP0015: fs.readSync legacy String interface # History Version Changes v8.0.0 End-of-Life. v6.12.0, v4.8.6 A deprecation code has been assigned. v6.0.0 Runtime deprecation. v0.1.96 Documentation-only deprecation. |
| `S1-C52` | `S1` | assert | 0.125 | Type: End-of-Life The fs.readSync() legacy String interface is deprecated. |
| `S1-C53` | `S1` | assert | 0 | DEP0016: GLOBAL / root # History Version Changes v14.0.0 End-of-Life. v6.12.0 A deprecation code has been assigned. v6.0.0 Runtime deprecation. |
| `S1-C54` | `S1` | assert | 0.25 | Type: End-of-Life The GLOBAL and root aliases for the global property were deprecated in Node.js 6.0..0 and have since been removed. |
| `S1-C55` | `S1` | assert | 0 | DEP0017: Intl.v8BreakIterator # History Version Changes v9.0.0 End-of-Life. v7.0.0 Runtime deprecation. |
| `S1-C56` | `S1` | assert | 0 | Type: End-of-Life Intl.v8BreakIterator was a non-standard extension and has been removed. |
| `S1-C57` | `S1` | assert | 0 | DEP0018: Unhandled promise rejections # History Version Changes v15.0.0 End-of-Life. v7.0.0 Runtime deprecation. |
| `S1-C58` | `S1` | assert | 0.125 | Type: End-of-Life Unhandled promise rejections are deprecated. |
| `S1-C59` | `S1` | assert | 0.125 | By default, promise rejections that are not handled terminate the Node.js process with a non-zero exit code. |
| `S1-C60` | `S1` | assert | 0.125 | To change the way Node.js treats unhandled rejections, use the unhandled-rejections command-line option. |

## Reproduce this run

```sh
bun run research "Is the built-in punycode module deprecated in Node.js, and what should replace it? Is the npm punycode package also deprecated?" --source "https://nodejs.org/api/deprecations.html"
```

Appended to the **sqlite** ledger at `/home/team/shared/engine/aletheia-ledger.db` as `a7589f83-3828-45a7-b053-f75110e4bb61`. Entry hash `997f59543b261b580823ef4661e3559598c2b03797137c315708c14703f0fc34`.

The ledger is append-only: this entry can never be edited or deleted. A correction is a new entry that supersedes `a7589f83-3828-45a7-b053-f75110e4bb61`.

## How this report was produced

- **Reasoning adapter:** `heuristic` (mode `deterministic_template`).
  - The verdict prose was produced by the deterministic template reasoner, not by a language model. Wording is mechanical; every sentence maps to a scored claim.
  - Confidence was computed from the rubric, not asserted by the reasoner.
- **Scoring:** rubric `aletheia-rubric@1.0.0` (sha256 `d851a304529c13d5866b0063d2825d8eb77af742548746d055d9ec6205d87297`), stored as data at `rubric/v1.json`. Every score in the appendix lists the raw inputs that produced it.
- **Conflicts:** policy `surface_never_average` — opposing claims are reported side by side and are never combined into one number.
- **Provider independence:** `direct-url`(ok), `web-search`(partial), `package-registry`(ok), `code-host`(ok), `qa-forum`(ok), `reference-docs`(partial).

_Provider configuration for this run:_

```json
{
  "direct-url": "ok (backends: http-get)",
  "web-search": "partial (backends: hn-algolia, hn-algolia, hn-algolia)",
  "package-registry": "ok (backends: npm, npm, pypi, maven)",
  "code-host": "ok (backends: github-issues, github-issues, github-issues, github-issues, github-issues, github-releases, github-releases)",
  "qa-forum": "ok (backends: stackexchange, stackexchange, stackexchange, stackexchange, stackexchange)",
  "reference-docs": "partial (backends: mdn, mdn, mdn, mediawiki)",
  "secrets.present": "TEAM_DB_EVENTS_TOKEN,IMAGE_UPLOAD_TOKEN"
}
```
