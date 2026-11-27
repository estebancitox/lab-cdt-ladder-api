# lab / cdt-ladder-api

One endpoint. It receives a CDT ladder (Colombian term deposits) and returns a
short explanation in plain English: what happens and when, and up to three risks
from a closed catalogue. The model never does arithmetic. Every figure is
recomputed on the server by the same engine the calculator runs, the model
receives finished figures only, and every reply is verified against rules
derived for that request before it is returned.

This is version 2.0, which moved the product from Spanish to English: the reply,
every fixed string, the JSON handed to the model and the rules that verify a
reply. The market stays Colombian. Version 1, the Spanish system, is the tag
`v1-es`.

**Live:** the "Explain this ladder" button in
[lab-cdt-ladder](https://estebancitox.github.io/lab-cdt-ladder/), the
calculator this endpoint explains. The URL is public within two daily caps; past
them a request answers 429 with a fixed message and a `retry-after` header.

## How a request is answered

A request walks a fixed pipeline, and the model is the fourth step, not the
first.

1. **Validate.** The body is refused over 8 KiB, before it is parsed; then JSON,
   the schema (`schemas/explain-request.v1.json`), the engine's own validation,
   the per-rung range limits and `asOfDate`, in that order. Over the cap is a
   413; any later failure is a 400 with a fixed message and the failing stage's
   issues, the engine's verbatim. Nothing has been spent.
2. **Recompute.** The vendored engine (`src/engine/`) computes every figure:
   period rates, gross interest rounded per rung, withholding on the rounded
   gross, maturities, per-entity exposure against the deposit-insurance ceiling.
   `src/explain/` adds the four derivations the calculator does not have (share of
   principal, headroom, maturity clusters, rate difference) and applies the risk
   priority.
3. **Count.** Two DynamoDB counters, one per client address and one for every
   client together, admit the request or refuse it with a 429. A request that
   failed validation never reaches them.
4. **Ask the model.** The payload carries finished figures and their display
   strings; the model's only job is to choose which of them to say and how. One
   call to `claude-sonnet-5-5` with prompt v2 (`src/model/prompt.v2.ts`) and a
   20 s deadline.
5. **Verify.** The rules of SPEC §11, derived for this request alone (§11.12),
   run on the reply: every number, date and percentage is one the server
   computed; every entity that holds a rung is mentioned, and every rung when
   there are at most six on distinct dates; each of the four risks is flagged
   if and only if the engine selected it, at most three by priority; no advice
   verbs; English, with no Spanish word of a closed list and no echoed payload
   key; a word budget by rung count; a guard against instructions smuggled in
   an entity name.
6. **Return, retry or refuse.** A reply that passes is returned as is. One that
   fails is never returned, with or without a warning: the handler retries once
   when the time budget allows it, and otherwise answers 502 with the failed
   rule names as metadata.

The reply is plain text in two sections with fixed headers (SPEC §4). Run 1 of
the first evaluation case, from the stored run of 2026-11-27 (3 218 input tokens,
204 output, $0.008476, 2 976 ms), is also the recorded example the calculator
offers when the service gave no answer:

```
What happens and when

Your ladder holds COP 50,000,000 of principal in 3 rungs across 3 institutions.

Rung 1 is at Banco Andino and matures on 4 April 2027. Rung 2 is at Cooperativa Ñame & Café and matures on 3 July 2027. Rung 3 is at Entidad B and matures on 1 October 2027. The next maturity is on 4 April 2027, 90 days from 4 January 2027.

The ladder pays COP 3,109,733 in interest after COP 129,572 of withholding tax.

Risks

No risks to flag with this data.
```

When a risk triggers, the second section holds up to three bullets, each opening
with a label from a closed vocabulary. The second case's run 1 ends with:

```
- Deposit-insurance ceiling: at Entidad A, principal plus interest before withholding tax comes to COP 50,069,493, which is COP 69,493 above the insurance ceiling of COP 50,000,000 you entered.
```

## The number stays honest

The policy at the head of the SPEC is the design in one sentence: **the number
stays honest — the claim moves, not the code.** Thresholds, comparison
semantics and rule definitions are fixed in the SPEC and are never loosened to
make a run look better. When the engine changes a formula, fixture numbers
follow it; the rules and thresholds do not. A rule that fails in production is
not loosened either: the answer is a retry, a 502 and a logged rule name.

The same discipline bounds what the model may say:

- **Every number must exist verbatim.** Exact set membership after
  normalization, with no tolerance (SPEC §5.1, §11.3). A bare year is not a date
  and fails the check.
- **No advice.** "should", "recommend" and the rest of a closed list may not
  appear (§5.2). The endpoint describes; it does not counsel.
- **A closed risk catalogue.** Four risks, four labels, nominal on purpose:
  "Deposit-insurance ceiling", "Concentration", "Clustered maturities", "Rate
  difference". The model may not add a rung, rename an entity or raise a risk
  the server did not trigger (§5.3). A label like "Low rate" would be a verdict,
  and a verdict sits badly next to a rule forbidding advice.
- **Fixed error strings.** Three byte-exact English messages cover every refusal
  (§7). No error path returns a 200 with a templated explanation, because a
  template that looks like an explanation would quietly satisfy every rule.

## What is measured

Nothing below is an estimate; each figure names where it comes from.

The evaluation suite is ten cases in `evals/cases.json`, eight valid and two
invalid, each a complete request body with its rules. The harness runs the same
engine the endpoint runs to derive the allowed numbers, so ground truth cannot be
influenced by whoever wrote the fixture. The last paid run, on 2026-11-27
(`evals/runs/2026-11-27T01-06-08Z/`), is the first run of version 2: English
replies under prompt v2. It made 26 runs and 24 model calls, three per valid
case, with no verification retry, and all 245 verdicts passed. It cost $0.217322
at list prices, $0.00906 per call on average, and the handler answered, model
call included, within 2 976 ms at the 95th percentile and 3 550 ms at worst.

Beside it, the last run of version 1, on 2026-10-29
(`evals/runs/2026-10-29T23-18-30Z/`): Spanish replies under the Spanish prompt,
judged by the v1 rules. It made 26 runs and 24 model calls too, and every rule
passed in every run. It cost $0.224490, $0.00935 per call on average, and
answered within 3 344 ms at the 95th percentile and 3 594 ms at worst. The two
runs are verdicts of different rules on text in different languages, so their
pass rates are not comparable (SPEC §10.2): under the rules of this version all
48 stored replies of version 1 fail the language rule.

A stored run of this version can be re-scored for free: `npm run eval:replay`
re-evaluates its replies with the rules as they are now and writes a report
beside them, never rewriting the measurement. On the run of 2026-11-27 it gives
every stored verdict again. Given a v1 run it says the run is not comparable and
writes nothing.

The test suite is 775 tests in 29 files, and `npm run test:ci` runs it twice,
under `TZ=America/Bogota` and under `TZ=UTC`, because every date is
calendar-day arithmetic that must not depend on the host's zone. The upstream
engine's own tests, 1 032 lines in 8 files, are among them.

The engine is a vendored copy, not a dependency: 18 files extracted from commit
`6e23cdd6ef1e02611fc82e908d7c6df1095641ce` of lab-cdt-ladder on 2026-11-26, never
edited, with a SHA-256 per file in `src/engine/VENDOR.md` that `src/vendor.test.ts`
re-hashes on every test run. CI (`.github/workflows/ci.yml`) runs the typecheck,
the two-zone suite and `scripts/verify-vendor.sh` against the pinned commit on
every push to `main`, with its actions pinned to commit SHAs; a second workflow
(`drift.yml`) compares `src/engine` at upstream `main` with the pin every Monday
and fails when they differ. No badge: the pipeline is the statement.

## Running in public

A public endpoint spends money per request for anyone who calls it, so the
daily caps and a concurrency limit stand between a request and the model, and
a spend alarm watches the spend (SPEC §8.2).

- **Two daily caps, counted before the model is called.** 100 requests per UTC
  day for every client together and 10 per client address (`DailyRequestLimit`
  and `IpDailyRequestLimit` in `template.yaml`), one conditional write each in a
  DynamoDB table with a TTL. Only a request that passed validation counts. A
  refused request is a 429 with the fixed message and a `retry-after` header,
  the seconds until the next 00:00 UTC. The table stores a hash of the day and
  the address, never the address, though an IPv4 hash is reversible by
  enumeration, as SPEC §12 records. A counter that cannot be written within
  1 500 ms refuses the request with a 503 rather than admitting it uncounted.
- **Concurrency.** At most two requests spend money at the same time
  (`ReservedConcurrentExecutions: 2`). Set to 0 by hand, it is the kill switch:
  the URL then answers 429 from the platform.
- **A spend alarm.** Two metric filters read the token counts from the log line;
  an alarm prices them at list prices over a sliding 24 hours and fires at $0.50
  (`DailySpendAlarmUsd`) through an SNS topic the owner subscribes to outside
  the repository. At the mean per call of the v1 run of 2026-10-29 that is about
  53 requests, and at the mean of the v2 run about 55, below the cap by design.
  The hard ceiling is the Anthropic organization's monthly spend limit, $20 as
  set on 2026-11-01, on a prepaid balance with auto-reload off.
- **CORS, which is not access control.** The URL names two origins,
  `https://estebancitox.github.io` and `http://localhost:5173`, the method
  `POST`, the header `content-type`, and exposes `retry-after`. It tells a
  browser which pages may read the reply; a script ignores it. The caps are what
  bound a caller.
- **A log line that carries no content.** One JSON line per request: a hash and
  the size of the body, rung and entity counts, status, latency, token counts,
  the cap that refused or the rule names that failed, and the class of any
  error, never its message (SPEC §8.4). Request bodies are someone's savings and
  their banks, and are never logged.

`UrlAuthType` is `NONE` as deployed. `AWS_IAM` makes the URL signed-only again
with one deploy, and it is the template's default, so a deploy that forgets the
override cannot open the URL.

## Run it yourself

Node 22, the version CI runs; nothing else is needed for the tests or a free
replay.

```sh
npm ci
npm run typecheck
npm run test:ci          # 775 tests under TZ=America/Bogota, then under TZ=UTC
npm run verify:vendor    # the vendored engine against ../lab-cdt-ladder at the pinned commit
npm run eval:replay -- evals/runs/2026-11-27T01-06-08Z/results.json   # free: re-scores the stored replies of the v2 run
```

A paid run needs the Anthropic API key in an AWS SSM SecureString, the name of
that parameter in `API_KEY_PARAMETER`, and AWS credentials that may read it. The
key itself is never an environment variable here. One run makes 24 model calls
when no reply needs a verification retry, and writes
`evals/runs/<timestamp>/results.json` and `report.md`. At list prices the v2
run of 2026-11-27 cost $0.217322, and the v1 run of 2026-10-29 $0.224490:

```sh
API_KEY_PARAMETER=/lab-cdt-ladder-api/anthropic-api-key AWS_PROFILE=lab AWS_REGION=us-east-2 npm run eval:live
```

Deploying is `sam build` and `sam deploy --guided` with the AWS SAM CLI. The
template's five parameters are the key's parameter name, `UrlAuthType`
(`AWS_IAM` by default, so the URL is private until `NONE` is passed), the two
caps and the alarm threshold. `scripts/invoke.sh` then sends one request from a
case of `evals/cases.json` to the deployed URL, signed with SigV4 by default, or
`--unsigned` as a browser would, `--preflight` for the CORS handshake,
`--oversize` for a body one byte over the cap, and `--dry-run` to see the body
without contacting anything.

## Repository map

The SPEC is long on purpose: it is the contract, and the code is tested against
it.

- `SPEC.md`: 2 373 lines, v2.0. §13 "Decisions" carries each revision's
  accepted, deferred and rejected items with dates, version 1's included.
- `docs/spec-review.md`: the adversarial review of 2026-09-13 that §13 points at.
  270 claims checked, 3 refuted, and the finding that moved the client out of
  the trust boundary.
- `schemas/explain-request.v1.json`: the request schema, JSON Schema draft-07.
- `evals/cases.json` and `evals/runs/`: the ten cases, version 2, and three
  stored runs: two of version 1, 2026-10-06 and 2026-10-29, and the first of
  version 2, 2026-11-27.
- `src/handler.ts`, `src/limits.ts`, `src/budget.ts`, `src/response.ts`: the
  pipeline, the caps, the time budget, the fixed bodies.
- `src/request/`: the byte cap, JSON, schema, engine validation and range limits.
- `src/explain/`: the explanation view, its four derivations and the risk
  priority.
- `src/model/`: prompt v2, the payload, the call with its deadline, the key read
  from SSM, and prompt v1, kept as the record of what the v1 runs ran against.
- `src/rules/`: the §11 rules, normalization, entity spans, ground truth and the
  derivation of the production rule set.
- `src/eval/`: the harness: the paid run, the replay, the report.
- `src/engine/`: the vendored engine and its tests, with `VENDOR.md`.
- `scripts/`: `invoke.sh` and `verify-vendor.sh`.
- `template.yaml`: one function behind a Function URL, the counters' table, the
  metric filters, the alarm and its topic, and the two permissions a public URL
  needs, declared under a condition.
- `.github/workflows/`: `ci.yml` and `drift.yml`.

## How it was built

The SPEC and the ten evaluation cases were written and reviewed before any code
existed: the first commit, on 2026-09-14, is the contract, the fixtures and the
record of an adversarial review of both. Each milestone since the first
deployment has a learning log entry; most had a plan stop with a human veto and
an independent review of their diff, and every one since 2026-10-28 has had
both. The work was AI-assisted in Claude Code: 30 of the 38 commits up to
2026-11-01 carry a `Co-Authored-By` trailer naming the assisting model, and the
others predate the habit, not the assistance. The numbers in this README come
from command output, stored runs and files, not from memory.

## The endpoint

`POST /` with a JSON body `{ asOfDate, ladder }` (SPEC §2). Every reply the
function writes is JSON with a `text` field; on anything but a 200, `text` is
one of three fixed strings and `error.code` says why (SPEC §7, §7.1). The
platform's own 429 in the table is the exception.

| Status | `error.code` | When | What the client sees |
|---|---|---|---|
| 200 | none | the reply passed verification | `text`, the explanation |
| 400 | `invalid_input` | body not JSON, schema violation, engine validation, a per-rung range limit, `asOfDate` invalid or after the last maturity | "I cannot explain this ladder: the data received is not valid." plus `error.issues` |
| 413 | `payload_too_large` | body over 8 KiB | the same message |
| 429 | `ip_limit_reached` | this address's daily cap reached | "I cannot explain this ladder for now: the daily request limit has been reached." plus `retry-after` |
| 429 | `daily_limit_reached` | the cap for every client together reached | the same message and header |
| 429 | none | the function throttled or switched off; the platform's own body | not this service's body: a client tells it apart by the missing `error.code` |
| 502 | `verification_failed` | the reply failed verification, with no time for a retry or on the retry too | "I cannot explain this ladder right now: the service is unavailable." plus the failed rule names in `error.issues` |
| 503 | `upstream_unavailable` | model unavailable or timed out, its key unreadable, or the counters unavailable | the same message |
| 503 | `upstream_truncated` | the reply cut at `max_tokens` | the same message |
| 500 | `internal_error` | a defect in the service | the same message |

On every 400 and 413, on both 429s and on the counters' 503, the model is never
called.
