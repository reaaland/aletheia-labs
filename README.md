# Aletheia Labs

Independent verification for software built with AI: **did this build actually do what
was intended, and what is the evidence?**

Aletheia takes a statement of intent and the artifact claiming to fulfil it — typically
code written by an AI coding agent — and works out whether the artifact meets the
intent, what failed, what could not be verified, and what evidence supports each
conclusion.

## Principles

- **No AI in the pipeline.** No model issues a verdict and no model sits anywhere in the
  engine. Verification is deterministic: the same inputs produce the same verdict, and
  every finding traces to the artifact, the documentation, an executed action, or a
  captured trace.
- **Evidence over assertions.** A passing test written by the original builder proves
  nothing. Only independently executed checks count.
- **Unverified is a real answer.** A requirement nobody checked is reported as
  unverified, never as passed.
- **A proposed fix is never a verified fix.** Corrections move through
  failure confirmed → cause identified → fix proposed → fix implemented → fix verified,
  and are reported at whichever stage they actually reached.
- **No single external provider is load-bearing.** Retrieval sits behind adapters with at
  least two independent implementations; swapping a source is configuration, not a
  rewrite.

## Layout

| Path | What it is |
| --- | --- |
| `engine/` | The verification engine: provider-agnostic retrieval, a versioned evidence-grading rubric, an append-only evidence ledger, and a CLI. |
| `fixture-app/` | A small, deliberately faulty web application, built from its own requirements document, used to measure the verifier against faults it was never told about. |

## Running it

Requires [Bun](https://bun.sh). No accounts, no API keys, no paid services.

```sh
cd engine && bun install && bun test          # engine test suite
cd fixture-app && bun test                    # fixture app test suite
cd fixture-app && bun run start               # serve the fixture app
```

## What is deliberately not here

The fixture application's **sealed answer key** — the list of faults planted in it and
their correct classifications — is not in this repository and never will be. It is what
makes the blind test blind: a verifier that can read the key cannot be measured on
whether it discovers anything. `.gitignore` blocks it as a second line of defence.

## Status

Early validation. Nothing here is claimed that has not been demonstrated; results,
including bad ones, are reported as they are.
