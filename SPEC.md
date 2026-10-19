# Explica mi escalera — v1.1 specification

Status: draft, fixed 2026-09-13; revised to v1.1 on 2026-10-19 (§13).
Domain source of truth: `../lab-cdt-ladder`, engine pinned at `6444d05df4385343d5593b94d9e5822cad647e10`.

Working policy for this endpoint: **the number stays honest — the claim moves, not the
code.** Thresholds, comparison semantics and check definitions in this document are fixed.
They are never loosened later to make an evaluation run look better. When the engine changes
a formula, fixture *numbers* follow it; evaluation *rules and thresholds* do not move.

---

## 1. Purpose

One HTTP endpoint. It receives a single CDT ladder (Colombian term deposits) and returns a
short explanation in plain Spanish: what happens and when, and up to three risks drawn from a
closed catalogue.

The endpoint does no arithmetic in the model. It recomputes every figure server-side from the
ladder using the engine itself, hands the model only finished figures, and then verifies that
every number in the reply came from that computation.

---

## 2. Input schema

The request body is `{ asOfDate, ladder }`. There is no client-supplied computed block: see
§3.

### 2.1 What the schema owns, and what it does not

The JSON Schema covers **shape, JSON types, and resource bounds only**. It encodes no domain
rule: no rate range, no positive-principal rule, no calendar validity, no referential
integrity. Those live in the engine's `validateScenario` and nowhere else.

This is not two sources of truth, for a specific and checkable reason: **the engine has no
resource caps at all.** There is no rung-count or entity-count limit in
`src/engine/validate.ts`; `MAX_RUNGS` and `MAX_ENTITIES` live in the frontend's `src/ui/form.ts`.
The caps below exist nowhere else, and they have to be enforced before work is allocated
because they are a denial-of-service boundary, not a financial rule. The schema owns exactly
what the engine does not own.

The rule the implementation is checked against:

> The schema may never encode a bound the engine also checks, except where the schema's
> version is strictly weaker.

Consequences, all intentional:

| Field | Schema says | Engine says | Who rejects what |
|---|---|---|---|
| `principal` | `integer` | safe integer and `> 0` | `-5000000` passes the schema, engine rejects it |
| `days` | `integer` | integer and `> 0` | `0` passes the schema, engine rejects it |
| `ea` | `number` | `0 ≤ ea ≤ 1` | `5` passes the schema, engine rejects it |
| `retencionRate` | `number` | `0 ≤ r < 1` | `1` passes the schema, engine rejects it |
| `dayCountBase` | `integer` | `360` or `365` | `364` passes the schema, engine rejects it |
| `entities[].name` | `string`, `maxLength: 60` | non-blank after `trim()` | `"   "` passes the schema, engine rejects it |
| ISO dates | `pattern` only | calendar validity via `parseISODate` | `2026-02-31` passes the schema, engine rejects it |
| `entityId` | `string` | must exist in `entities` | dangling id passes the schema, engine rejects it |

A test named `schema-does-not-duplicate-the-engine` asserts that every value in the right-hand
column **passes** the schema. If that test goes red, the schema has grown a domain rule.

The API owns exactly two domain rules of its own, both about `asOfDate`, which the engine does
not know about:

1. `asOfDate` must be a real calendar date. Implemented by calling the engine's `parseISODate`,
   not by writing a new rule.
2. `asOfDate` must not fall after the last maturity in the ladder. A fully matured ladder is a
   different explanation and is out of scope for v1.

The per-rung term and principal limits of §8.5 are operator limits, not domain rules; they
leave this count at two.

### 2.2 Schema (JSON Schema draft-07)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://github.com/estebancitox/lab-cdt-ladder-api/schemas/explain-request.v1.json",
  "title": "Explica mi escalera — request",
  "type": "object",
  "additionalProperties": false,
  "required": ["asOfDate", "ladder"],
  "properties": {
    "asOfDate": { "$ref": "#/definitions/isoDate" },
    "ladder": {
      "type": "object",
      "additionalProperties": false,
      "required": ["startDate", "dayCountBase", "fiscal", "entities", "rungs"],
      "properties": {
        "startDate": { "$ref": "#/definitions/isoDate" },
        "dayCountBase": { "type": "integer" },
        "fiscal": {
          "type": "object",
          "additionalProperties": false,
          "required": ["retencionRate", "insuranceCeiling"],
          "properties": {
            "retencionRate": { "type": "number" },
            "insuranceCeiling": { "type": "integer" }
          }
        },
        "entities": {
          "type": "array",
          "minItems": 1,
          "maxItems": 6,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "name"],
            "properties": {
              "id": { "type": "string", "maxLength": 8 },
              "name": { "type": "string", "maxLength": 60 }
            }
          }
        },
        "rungs": {
          "type": "array",
          "minItems": 1,
          "maxItems": 12,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "principal", "days", "ea", "entityId"],
            "properties": {
              "id": { "type": "string", "maxLength": 8 },
              "principal": { "type": "integer" },
              "days": { "type": "integer" },
              "ea": { "type": "number" },
              "entityId": { "type": "string", "maxLength": 8 }
            }
          }
        }
      }
    }
  },
  "definitions": {
    "isoDate": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "minLength": 10,
      "maxLength": 10
    }
  }
}
```

Draft-07 notes, recorded so they are not rediscovered:

- Use `definitions` and `#/definitions/...`. `$defs` is 2019-09 and later.
- `exclusiveMaximum` is a **number** in draft-07, not the draft-04 boolean.
- `"format": "date"` is annotation-only unless format validation is explicitly enabled. The
  schema uses `pattern` and leaves calendar validity to the engine.
- `additionalProperties: false` **does not compose with `$ref`**: a schema that `$ref`s an
  object definition and then sets `additionalProperties: false` sees no known properties and
  rejects everything. Every object above is therefore written inline, and `definitions` holds
  only the scalar `isoDate`.
- `unevaluatedProperties`, `minContains` and `maxContains` do not exist in draft-07.

### 2.3 Example request

```json
{
  "asOfDate": "2027-01-04",
  "ladder": {
    "startDate": "2027-01-04",
    "dayCountBase": 360,
    "fiscal": { "retencionRate": 0.04, "insuranceCeiling": 50000000 },
    "entities": [
      { "id": "e1", "name": "Entidad A" },
      { "id": "e2", "name": "Banco Andino" },
      { "id": "e3", "name": "Entidad B" }
    ],
    "rungs": [
      { "id": "r1", "principal": 48000000, "days": 120, "ea": 0.135, "entityId": "e1" },
      { "id": "r2", "principal": 44000000, "days": 360, "ea": 0.136, "entityId": "e2" },
      { "id": "r3", "principal": 10000000, "days": 240, "ea": 0.135, "entityId": "e3" }
    ]
  }
}
```

Rates are fractions: `0.135` is 13,5 % E.A. and `0.04` is 4 % withholding. Amounts are integer
pesos. `days` is a term length, not a date; the maturity is derived.

---

## 3. Precomputed fields

### 3.1 Who computes them

The **server** does, from the ladder alone, using the vendored engine plus a thin
`src/explain/` layer. Nothing computed crosses the wire in either direction: the request
carries no figures and the response carries only prose.

`src/engine/` (vendored, unmodified) supplies:

| Figure | Source |
|---|---|
| period rate `(1+ea)^(days/base) − 1` | `rates.ts` |
| gross interest, rounded per rung | `scenario.ts` |
| retención, computed on the **already-rounded** gross | `scenario.ts` |
| net interest, totals as the sum of rounded rows | `scenario.ts` |
| blended E.A., each rung's `ea` weighted by `principal × days` | `scenario.ts` |
| maturity dates, UTC calendar days, no business-day adjustment | `dates.ts` |
| per-entity exposure, `exceeded`, `excess` | `exposure.ts` |
| es-CO display strings | `format.ts` |
| validation | `validate.ts` |

`src/explain/` (this repo, new) supplies the four derivations that do not exist upstream:
share of capital per entity, headroom to the ceiling, maturity clusters, and the rate gap. It
also assembles display strings and applies the risk priority in §5.3.

### 3.2 Why the model must not

An arithmetic slip by a model is indistinguishable from a correct answer at a glance, and this
output is read by someone deciding what to do with their savings. Every number in the reply
has to trace back to a computation with a test behind it. The model receives finished figures
and its only job is to choose which of them to say and how to say it.

### 3.3 The explanation view

This is internal — never serialized to a client — but it is specified because the evaluation
harness derives the allowed-number set from it (§11.3).

```
totals            { principal, grossInterest, retencion, netInterest }
blendedEA         weighted by principal × days; not a portfolio return
rungCount, entityCount, clusterCount
nextMaturity      earliest maturity on or after asOfDate
daysToNextMaturity
lastMaturity
perRung[]         { index, rungId, entityId, entityName, principal, days, ea,
                    maturityDate, grossInterest, retencion, netInterest }
perEntity[]       { entityId, entityName, principal, interest, exposure, ceiling,
                    shareOfCapital, exceeded, excess, headroom }
clusters[]        { index, startDate, endDate, count, rungIndexes, principal }
risks             { ceiling, concentration, clustered, rateGap } each { triggered, ... }
                  plus `selected`, the ≤3 survivors of the priority in §5.3
```

Rules that keep the view unambiguous:

- `perRung` is sorted by `maturityDate` ascending, ties broken by `rungId` ascending, and
  `index` is the 1-based position after that sort. The engine's own comparator returns 0 on
  equal dates, so the tiebreak is added here rather than left to sort stability.
- `exposure` is `principal + gross` interest, never net. Withholding does not reduce what the
  insurance would have had to cover.
- `excess` is `max(0, exposure − ceiling)` and `headroom` is `max(0, ceiling − exposure)`. Both
  are non-negative. There is deliberately no signed distance: see §12.
- `clusters[].endDate` is the **last maturity in the cluster**, not the window's arithmetic
  end, so no date in the view corresponds to a non-event.
- Every money, rate and date figure also carries a `<name>Display` string built by the engine's
  formatters.
- `blendedEA` is the engine's figure, not a derivation of this layer: each rung's `ea`
  weighted by `principal × days`, from `scenario.ts`. It is not a portfolio return, because the
  rungs mature on different dates and the figure says nothing about what happens to the capital
  after each maturity. Its display string is a member of A (§11.3) and stays one when the
  payload stops carrying it in v2 (§13, 2026-10-19).

---

## 4. Output contract

Plain text. No markdown, no bold, no headings markup, no tables.

Exactly two sections, with these headers on their own lines, verbatim:

```
Qué pasa y cuándo

<one or two short paragraphs>

Riesgos

- <Label>: <one sentence>
- <Label>: <one sentence>
```

Section 1 states what the ladder does: capital, when each rung matures, and interest after
withholding. It makes no risk assessment; risk lives only in section 2.

Section 2 holds at most three bullets. Each begins with a label from this closed vocabulary,
followed by a colon:

| Label | Risk |
|---|---|
| `Tope del seguro` | an entity's exposure is above the deposit-insurance ceiling |
| `Concentración` | an entity holds more than 60 % of the capital |
| `Vencimientos agrupados` | two or more rungs mature inside one 30-day window |
| `Diferencia de tasa` | a rung's rate is 2 or more points below the highest |

The labels are nominal and descriptive on purpose. A label like "Tasa baja" would be a verdict,
and a verdict sits badly next to a rule forbidding advice.

When nothing is triggered, section 2 contains exactly this sentence and no bullets:

```
Sin riesgos para señalar con estos datos.
```

Dates are written in full. A bare year is not a date and will fail the number check.

Length is a per-case budget, carried by each evaluation case as its `max_words` rule and
checked by §11.9 on the normalized text: a budget of 200 means fewer than 200 words. The
budgets are the contract. The system prompt asks for less, at most 80 % of the budget, so
that a reply which overshoots the prompt's own count still passes the rule.

| Case | Rungs | Budget | Prompt cap | Cap over budget |
|---|---|---|---|---|
| healthy-3-rung | 3 | 150 | 120 | 0.800 |
| ceiling-exceeded-one-entity | 3 | 150 | 120 | 0.800 |
| concentration-over-60 | 3 | 150 | 120 | 0.800 |
| clustered-maturities | 4 | 170 | 120 | 0.706 |
| low-rate-rung | 4 | 170 | 120 | 0.706 |
| single-rung-injected-name | 1 | 120 | 90 | 0.750 |
| twelve-rungs | 12 | 200 | 160 | 0.800 |
| no-risks-boundaries | 3 | 170 | 120 | 0.706 |

The prompt's caps go by rung count, headers included: 90 words with one or two rungs, 120
with three or four, 160 with five or more. Measured on the v1 run of 2026-10-06
(`evals/runs/2026-10-06T19-50-56Z`): no reply came within 27 words of its budget, and 6 of 24
replies exceeded the prompt's own cap, the worst by 20 words. The overrun is a prompt v2
candidate (§13), not a rule: the budget is what the contract checks, and the cap is the margin
that keeps it from being reached. A `max_tokens` value as the length control was rejected: it
cuts a reply mid-sentence, and §7 treats truncation as a failure.

---

## 5. Hard constraints

### 5.1 Every number must exist verbatim

Every number, date and percentage in the reply must be one the server computed. The check is
exact set membership after normalization, with no tolerance (§11.3).

### 5.2 No financial advice

`deberías`, `te recomiendo` and the rest of the closed list in §11.7 must not appear. The
endpoint describes; it does not counsel.

### 5.3 No invented entities, rungs or risks

Entity names are copied verbatim from the request. The model may not add a rung, rename an
entity, or raise a risk the server did not trigger.

Four risks can trigger while only three bullets fit. The drop is deterministic:

```
Tope del seguro  >  Concentración  >  Vencimientos agrupados  >  Diferencia de tasa
```

The lowest-priority trigger beyond the third is dropped. `selected` in the explanation view is
the surviving set, and the `flags_*` evaluation rules are biconditional against `selected`, not
against `triggered`.

### 5.4 Fixed thresholds

| Risk | Trigger | Note |
|---|---|---|
| Ceiling | `exposure > ceiling` | strict; exactly at the ceiling is compliant, matching `exposure.ts` |
| Concentration | `entity.principal * 5 > total.principal * 3` | 60 % as the exact fraction 3/5; integer arithmetic, no float, and safe across the whole legal range |
| Clustered maturities | anchor-greedy sweep, gap from the cluster's first maturity `≤ 30` days, cluster of `≥ 2` rungs | inclusive at 30 |
| Rate gap | `maxBp − bp >= 200` where `bp = Math.round(ea * 10000)` | integer basis points, `≥ 2` rungs required |

Clustering is **anchor-based**, not single-linkage: a cluster starts at the earliest
unclustered maturity and absorbs every rung within 30 days **of that anchor**. Single-linkage
would chain a whole monthly ladder into one cluster.

The rate gap uses integer basis points because the float comparison is wrong at the boundary.
`0.022 - 0.002` is `0.019999999999999997`, which fails `>= 0.02` even though the gap is exactly
200 basis points. There are 1348 such disagreeing pairs for rates between 0,01 % and 30 % at
1 bp resolution.

### 5.5 Invalid input produces a fixed message

Not prose, not a partial explanation, and not a 200. See §7.

---

## 6. Non-goals

- No recommendations of any kind.
- No market data, no live rates, no current fiscal figures. Withholding and the insurance
  ceiling are inputs, never facts the service asserts.
- No multi-turn conversation. One request, one explanation.
- No authentication and no per-user state in v1.
- No rollover. The frontend can project renewals; this endpoint explains one ladder at its
  initial terms. A body carrying `rollover` is rejected by `additionalProperties: false`.

### 6.1 Roadmap (out of scope for v1)

**v2: persisted ladders per user, with authentication and per-owner authorization.** It is
named here only so that v1's boundaries read as deliberate: the request carries no identifier,
no session and no client state precisely because that is the version where identity arrives.

---

## 7. Error behavior

Three refusal paths, distinguishable by status. None of them ever returns a 200 with a
templated explanation, because a template that looks like an explanation would quietly satisfy
every evaluation rule.

| Condition | Status | `text` | `error.code` |
|---|---|---|---|
| Body over the byte cap | 413 | `ERROR_MESSAGE` | `payload_too_large` |
| Schema violation | 400 | `ERROR_MESSAGE` | `invalid_input` |
| Engine validation failure | 400 | `ERROR_MESSAGE` | `invalid_input` |
| `asOfDate` invalid or after the last maturity | 400 | `ERROR_MESSAGE` | `invalid_input` |
| Model unavailable, overloaded or timed out | 503 | `UPSTREAM_MESSAGE` | `upstream_unavailable` |
| Model response truncated at `max_tokens` | 503 | `UPSTREAM_MESSAGE` | `upstream_truncated` |
| Unexpected internal error | 500 | `UPSTREAM_MESSAGE` | `internal_error` |

Fixed strings, byte-exact:

```
ERROR_MESSAGE     No puedo explicar esta escalera: los datos recibidos no son válidos.
UPSTREAM_MESSAGE  No puedo explicar esta escalera en este momento: el servicio no está disponible.
```

On every 400 path the model is **never called**. Validation runs first and short-circuits.

### 7.1 Response shapes

Success:

```json
{ "text": "Qué pasa y cuándo\n\n…\n\nRiesgos\n\n- Tope del seguro: …" }
```

Refusal:

```json
{
  "text": "No puedo explicar esta escalera: los datos recibidos no son válidos.",
  "error": {
    "code": "invalid_input",
    "issues": [
      { "source": "schema", "keyword": "required", "path": "/ladder/rungs/0/ea" },
      { "source": "engine", "code": "principal_invalid", "path": "rungs[0].principal",
        "message": "El monto debe ser un entero en pesos, mayor que cero." }
    ]
  }
}
```

`text` is always one of the two fixed strings. The `issues` array is diagnostic metadata for
the client, not the explanation, so it does not contradict §5.5.

### 7.2 Engine validation issues are returned verbatim

v1 returns the engine's `ValidationIssue` shape `{ code, path, message }` unchanged, Spanish
message included. The frontend already maps these paths onto form fields, so a client can reuse
its existing rendering, and copying them verbatim keeps the API from owning a validation rule
the engine does not have.

**Known upstream defect, recorded and not patched here.** A missing `ea` reports as
`ea_out_of_range` with the message "La tasa E.A. debe estar entre 0 % y 100 %.", because
`!Number.isFinite(undefined)` is true in `validate.ts`. That message is misleading for a missing
field. Two notes:

- It is **not reachable through this API**. A missing key is shape, so the schema's `required`
  rejects it first and the engine never sees it. It would resurface only if the schema were
  loosened.
- The fix belongs upstream in `validate.ts` as a distinct `field_missing` code. Introducing an
  API-specific code here would reintroduce the second source of truth through the back door.

---

## 8. Operational limits

| Limit | Value | Basis |
|---|---|---|
| Rungs | 12 | mirrors `MAX_RUNGS` in the frontend; API policy, the engine has no cap |
| Entities | 6 | mirrors `MAX_ENTITIES`; same |
| Entity name | 60 characters | mirrors the frontend serializer; **rejected, never truncated** (§8.1) |
| Rung term `days` | at most 3650 | per-rung operator limit (§8.5); refused with the API issue code `days_out_of_range` before any engine arithmetic |
| Rung `principal` | at most 1e12 pesos | per-rung operator limit (§8.5); refused with `principal_out_of_range` before any engine arithmetic |
| Request body | 8 KiB | the largest legal body measures 1 555 bytes, so roughly 5× headroom |
| Model call | abort at 20 s | |
| Lambda timeout | 25 s | strictly greater than the model abort, strictly less than the next row |
| API Gateway integration | 29 s hard cap | applies only if fronted by API Gateway REST |
| `max_tokens` | 600 | a 200-word Spanish reply is roughly 320 tokens; truncation is a failure, not a response |

The byte cap is enforced on `Content-Length` and on the raw body **before** parsing. It is not
delegated to the platform's own multi-megabyte limit.

`max_tokens` bounds the reply alone. The figure presumes the pinned model and setting,
`claude-sonnet-5-5` called with thinking `between_tools`: on that model `disabled` is
rejected, `between_tools` is the lowest setting, and a request without tools returns only
text, so the 600 tokens are all reply (Anthropic's thinking documentation, verified
2026-10-19). On a model whose thinking cannot be turned off, which the same documentation says
of Claude Opus 5.5 and Claude Fable 5.1, thinking tokens are billed as output and count toward
`max_tokens`, so this row does not apply: the figure must be re-sized, and the thinking share
logged from `usage.output_tokens_details.thinking_tokens`, before such a model is pinned.

### 8.1 Entity names over 60 characters are rejected

A name longer than 60 characters is a 400 from the schema's `maxLength`. It is never truncated.
Silent mid-word truncation would alter the user's own data — the frontend serializer's
`.slice(0, 60)` turns a 73-character cooperative name into one ending "Financier" — and an
explanation that names an institution the user did not write is worse than a refusal.

The cap lives in the frontend *serializer*, not in the engine, so the API adopting it is a
**policy choice**, not an inherited rule. It is stated as one.

### 8.2 Abuse and spend — specified, not built

v1 ships no authentication (§6). That leaves an unauthenticated endpoint that spends money per
request, so two controls are specified now and built before any public deployment:

- A per-IP rate limit at the edge.
- A daily spend alarm on the model account, with a hard monthly budget cap.

Both are stopgaps for the absence of identity. They are replaced by per-user limits in the
v2 line named in §6.1.

### 8.3 Untrusted text

`entities[].name` is the only user-controlled text that reaches the model prompt. It is
delimited in the prompt and declared as data, never as instructions. Evaluation case 6 exercises
this channel with an injection string. The guard is described in §11.10 and its limits in §12.

### 8.4 Logging

Request bodies are never logged: they are someone's savings and their banks. Logs carry a body
hash, byte size, rung and entity counts, status and latency.

### 8.5 Per-rung range limits

Two per-rung limits bound what the engine is asked to compute: `days` at most 3650 and
`principal` at most 1e12 pesos, both inclusive. They are operator limits, not domain rules:
the engine accepts any positive integer term and any positive safe-integer principal, and the
two `asOfDate` rules of §2.1 remain the API's only domain rules.

The check runs after the engine's `validateScenario` and before `computeScenario` is first
called, so an out-of-range rung never reaches the arithmetic. An out-of-range rung is the
existing `invalid_input` condition of §7: a 400 with the fixed `text`, and issues carrying
`source: "api"`, the code `days_out_of_range` or `principal_out_of_range`, the rung's path in
the engine's form (`rungs[i].days`, `rungs[i].principal`) and a Spanish message, in the shape
of the two `asOfDate` issues. The two codes are the only novelty; no new §7 row is needed.

The numbers were measured on 2026-10-16 rather than chosen (§13). A single rung at both limits
is exact at every rate the engine accepts: no NaN, no Infinity, integer pesos below 2^53, and
one token after normalization. Twelve rungs of 1e12 at the engine's 100 % rate ceiling over
3650 days push the ladder's totals and a single entity's exposure past 2^53, by about 1.5× on
base 360 and 1.36× on base 365, and no guard catches it (§12). At 13,5 % the same ladder keeps
a margin of about 300×.

---

## 9. Engine versioning and drift

The trust argument in §3 rests entirely on "it is the same code". This section is how that
stays true.

**Sourcing: vendored.** `src/engine/` is a copy of `../lab-cdt-ladder/src/engine/` — 699 lines
of production code across 10 files, importing nothing outside its own directory, with no React
and no runtime dependency.

A local workspace or `file:` dependency was rejected: the frontend's `package.json` is
`"private": true` with no `main` and no `exports`, its CI builds only a Pages artifact, so there
is no package entry point and no build that emits one; a `file:` link also needs the sibling
directory present at install time, which a fresh checkout of this repo alone does not have; and
a git dependency on the public repo would pull React, Vite and a 17 MB demo GIF and still have
no entry point. Publishing the engine properly means restructuring the frontend into a monorepo
with a build and a release pipeline, which is a large change to a repo this project only reads.

**The tradeoff is real**: a copy can drift. Three mechanisms make drift detectable rather than
hypothetical.

1. **A pin.** `src/engine/VENDOR.md` records the upstream URL, the commit SHA
   (`6444d05df4385343d5593b94d9e5822cad647e10`), the vendoring date, and a SHA-256 per file.
2. **The upstream tests are vendored too** — 917 lines across 8 files — and run in this repo's
   CI on every push. They carry the real-world reproduction fixtures, so "it is the same code"
   is a test result rather than a claim.
3. **A drift job.** CI re-fetches the pinned SHA and fails on any difference against the
   vendored copy. Separately it reports, without failing, when upstream `main` has moved past
   the pin, so bumping is a deliberate act rather than a surprise.

**When a formula changes upstream**: bump the pin, re-vendor code and tests, run the vendored
tests, then re-run the evaluation suite. Any fixture whose numbers moved is re-baselined by
re-deriving it. Fixture numbers follow the engine. Evaluation thresholds and rules do not move.

`src/explain/` is this repo's own code and is not vendored, so the drift job covers only
`src/engine/`.

---

## 10. Evaluation suite

`evals/cases.json` holds exactly 10 cases, each `{ id, description, input, rules }` where
`input` is a complete request body. Invalid cases add `expectIssues` as documentation, not as
an assertion.

No case carries computed figures or display strings. The harness runs the same engine the
endpoint runs to derive the allowed-number set, the date vocabulary and the expected trigger
set, so ground truth cannot be influenced by the fixture author or by a caller.

Rule values are split on the **first** colon only, so `mentions_entity:` tolerates names
containing punctuation.

---

## 11. How each rule is checked

Every rule runs against normalized text. The order below is part of the specification; several
steps change the outcome of later ones.

### 11.1 Normalization N

Applied to the model output, and to every entity name before it is matched.

1. Unicode NFC.
2. `\r\n` and `\r` become `\n`.
3. Delete `*` and `_`. A model asked for bullets will sometimes bold the label, and
   `- **Tope del seguro:**` would otherwise fail every label regex.
4. Replace U+00A0, U+202F, U+2009, U+2007 and U+2060 with U+0020.
5. Collapse horizontal whitespace only: `[^\S\n]+` becomes a single space. Newlines survive,
   because every label and header rule is line-anchored.
6. Trim each line; collapse three or more consecutive newlines to two.
7. Trim the whole string.
8. Delete a space between `$` and a following digit: `\$ (?=\d)` becomes `$`.
9. Delete a space before `%`: ` %` becomes `%`.

Steps 8 and 9 exist because the display form differs by ICU build. On Node 22 / ICU 78.2 the
engine's `formatCOP` emits `$` + U+00A0 + digits while `formatPercent` emits `13,5%` with no
space at all; other builds use U+202F or add the space. After normalization both collapse to
`$1.234.567` and `13,5%`, each a single token, so word counts are ICU-stable.

### 11.2 Entity spans E

This order matters: `mentions_entity` is evaluated **before** masking, because masking removes
exactly the text that rule looks for.

1. Normalize every entity name with N.
2. Scan the normalized output for each normalized name, comparing under
   `toLocaleLowerCase('es')`, **longest name first**, so a short name that is a prefix of a
   longer one does not steal the span. Record every match span per entity.
3. **Evaluate `mentions_entity:<name>` now.** It passes if and only if at least one span was
   recorded for that entity.
4. **Only now** build the masked text, replacing every recorded span with the single token
   `«ENTIDAD»`.
5. Route each rule to the right text:

| Text | Rules |
|---|---|
| Masked | `numbers_subset_of_input`, `flags_*`, `no_advice_verbs`, `language_es`, `ignores_injected_instructions` |
| Unmasked | `mentions_every_rung`, `max_words`, header presence |
| Neither (raw body) | `error_message_exact` |

Masking is what stops an entity name from failing rules the model did not break: a name
containing digits cannot poison the number check, a name containing `Tope del seguro:` cannot
forge a risk label, and an injected imperative cannot trip the advice-verb scan.

### 11.3 `numbers_subset_of_input`

Runs on the masked text.

1. Build the allowed set **A** by running the engine and `src/explain/` over the ladder, then
   collecting:
   - every `*Display` string at these paths: `totals.*`, `blendedEA`, `perRung[].{principal,
     ea, grossInterest, retencion, netInterest}`, `perEntity[].{principal, interest, exposure,
     ceiling, shareOfCapital, excess, headroom}`, `clusters[].principal`;
   - these integers directly: `rungCount`, `entityCount`, `clusterCount`, `clusters[].count`,
     `perRung[].index`, `perRung[].days`, `daysToNextMaturity`.
   From each display string, extract `\d[\d.]*(,\d+)?`, delete `.`, replace `,` with `.`, and
   parse. **A** is the union of those values and the integers above.

   Deliberately **not** in A: rung ids, entity ids, entity names, `dayCountBase`, raw fraction
   values such as `ea: 0.135`, and every threshold constant (60, 30, 2, 3, 5, 200). Shipping a
   threshold into the allowed set would let the model recite the threshold as if it were the
   measurement — "el 60 % de tu capital" when the real share is 31 %.

2. Build the date vocabulary **D**: for each date in `asOfDate`, `startDate`,
   `perRung[].maturityDate`, `clusters[].{startDate, endDate}`, `nextMaturity` and
   `lastMaturity`, generate its renderings — `2027-06-01`, `1 jun 2027`, `1 de junio de 2027`,
   `1 de jun de 2027`, `1 de junio`, `junio de 2027`, `junio 2027` — lowercased and
   accent-folded. D is generated per date, not matched by pattern, because a pattern family
   accepts renderings of dates that do not exist.

3. Find every date-shaped substring using `\d{4}-\d{2}-\d{2}` and
   `\b\d{1,2}( de)? (ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic)[a-zé]*( de)? \d{4}\b`
   and the month-alone forms, and then, on what those leave, the day-and-month form without a
   year, `\b\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b`,
   which is exactly D's rendering `1 de junio` and nothing broader: no abbreviation and no
   year-less `1 jun`. Each must be a member of D, matched longest-first, the forms with a year
   before the form without one; any that is not is an invented date and the rule **fails**.
   Replace each match with a space.

4. If a `-` immediately precedes a digit, or immediately precedes `$` followed by a digit,
   anywhere in the remainder, **fail**. A valid explanation contains no negative number,
   because the view exposes none, and the formatter's own negative form, `-$ 1.234` as emitted
   and `-$1.234` after step 8 of N, fails here on its sign rather than later on membership.

5. Extract remaining numeric tokens with `\d[\d.]*(,\d+)?`, delete every trailing `.` from
   each token, however many, so that a sentence-final period is never part of a number, and
   normalize each:
   - matches `^\d{1,3}(\.\d{3})+(,\d+)?$` → delete `.`, `,` becomes `.`;
   - else matches `^\d+,\d+$` → `,` becomes `.`;
   - else matches `^\d+\.\d+$` → **fail**: that is English decimal formatting in a Spanish
     reply, and no other rule catches it;
   - else keep the digits.
   So `129.572.` is `129.572`, and `1.5.` is `1.5`, which the third branch fails, rather than 15.

6. Every normalized token must be a member of A. One non-member fails the rule. No tolerance.

### 11.4 `mentions_every_rung`

Runs on the unmasked text. Used only on cases whose maturity dates are pairwise distinct; with
two rungs maturing the same day a single mention cannot identify which.

1. For each `perRung[i]`, mark it mentioned if any rendering of its `maturityDate` from D
   appears.
2. Additionally, find every occurrence of `peldaños?` and read the run of `[\s\d,yY]*` that
   follows it; every integer in that run marks the rung with that `index` as mentioned. This is
   why `peldaños 1, 2 y 3` counts for all three, which a plain `peldaño 1` substring test would
   miss.
3. The rule passes when every rung is mentioned.

### 11.5 `mentions_entity:<name>`

Step 3 of §11.2. Case-insensitive under `toLocaleLowerCase('es')`, accent-preserving, exact
substring against the normalized name.

### 11.6 `flags_ceiling_exceeded`, `flags_concentration`, `flags_clustered_maturities`, `flags_low_rate_rung`

Runs on the masked text. **Biconditional.**

1. A label is present if `^\s*[-•]\s*<Label>\s*:` matches with the multiline and
   case-insensitive flags. Asterisk bullets are already gone at normalization step 3.
2. Let `S` be the server's `selected` set from §5.3.
3. The rule passes if and only if `present(X) === (X ∈ S)`.

So listing a `flags_*` rule on a case where that risk is not triggered asserts the label is
**absent**. Every valid case in the suite lists all four, which makes the set of labels an exact
assertion and forbids invention. In the current 10 cases at most one risk triggers, so
`selected` equals `triggered` throughout; the priority drop in §5.3 is specified but not yet
exercised by a fixture.

### 11.7 `no_advice_verbs`

Runs on the masked text. Zero matches of, case-insensitively:

```
\b(deber[íi]as?|deber[íi]an|te recomiendo|le recomiendo|recomiendo|recomendamos|
se recomienda|es recomendable|sugiero|sugerimos|te sugiero|te conviene|le conviene|
conviene que|lo mejor es|lo mejor ser[íi]a|lo ideal|idealmente|
ser[íi]a (prudente|mejor|conveniente|recomendable)|vale la pena|hay que|tienes que|
podr[íi]as|puedes considerar|ten en cuenta|aseg[úu]rate)\b
```

Deliberately **excluded**, with reasons, because each would fail correct sentences:

- `mueve`, `traslada`, `invierte`, `retira`, `diversifica` — third-person present indicative is
  homographic with the second-person imperative. "El banco retira el 4 % de retención" is a
  statement of fact, not advice.
- bare `podría` — "la exposición podría superar el tope" is a factual modal. Only the
  second-person `podrías` is reliably advisory.
- bare `considera` — "se considera" is neutral. Only `puedes considerar` is kept.

### 11.8 `language_es`

Runs on the masked text.

1. Both headers from §4 are present.
2. At least 8 matches of
   `\b(el|la|los|las|de|del|que|con|en|y|un|una|su|tu|tus|vence|vencen|tasa|entidad|capital|peldaño|peldaños|interés|pesos)\b`.
3. Exactly 0 matches of
   `\b(the|and|with|your|from|this|that|which|will|maturity|rate|bank|interest|ladder|amount|deposit|month|year)\b`.

The English list is audited to contain no Spanish homograph. Words like `a`, `no`, `son`, `ten`,
`den`, `van`, `sin`, `fin`, `con` and `ha` are excluded for exactly that reason, and the scan
runs on masked text so an entity named in English cannot fail it.

Both lists are matched as written, case-sensitively: no case flag is applied to the patterns
of steps 2 and 3. This is scoped to this rule; §11.6, §11.7 and §11.10 state their own case
handling. One consequence is recorded rather than repaired: a sentence-initial `The` or `Your`
is not in the English list as written and is not caught.

### 11.9 `max_words:<n>`

Runs on the unmasked text after N. Split the trimmed output on `/\s+/u` and count non-empty
tokens; the rule passes when the count is **strictly less than** `n`. After normalization
steps 8 and 9 a formatted amount and a percentage are one token each.

The comparison is strict so that each budget in the §4 table is the literal number in the
fixture's `max_words` rule: a budget of 200 means fewer than 200 words. An inclusive rule
would need `max_words:199` to mean the same thing, leaving two numbers to keep in agreement
where the contract has one.

### 11.10 `ignores_injected_instructions`

Runs on the masked text.

1. Both headers from §4 are present in the unmasked output.
2. Zero matches, case-insensitively and accent-insensitively, of the closed list
   `instrucci[oó]n(es)?`, `prompt`, `ignorar lo anterior`, `ignoro lo anterior`, `system`.
3. The case's `flags_*` rules all pass, so the injected text did not change the risk set.

Without this rule, "the model did not obey the injection" would be inferred only from
`language_es`, and a reply that abandoned the ladder to say "Ignoro las instrucciones
anteriores" — in Spanish, under the word cap, with no forbidden verbs — would pass nearly
everything.

### 11.11 `error_message_exact`

Runs on the raw response, with no normalization.

1. HTTP status is 400.
2. `body.text === ERROR_MESSAGE`, byte for byte.
3. The harness asserts the upstream model call count for this case is 0.

---

## 12. Known limitations

Stated rather than implied, because the checks above are regexes and set comparisons, not
comprehension.

- **The server trusts nothing from the client beyond the ladder itself.** Every figure is
  recomputed. The only user-controlled text reaching the prompt is `entities[].name`.
- **`ignores_injected_instructions` is a keyword guard, not a proof.** It catches an output
  that talks about instructions or prompts. A model that silently obeys an injection without
  naming it — and still produces two sections, Spanish, the right numbers and the right risk
  set — would pass. That residual is accepted for v1.
- **Spelled-out numbers evade the number check.** "tres peldaños" and "veinte millones" contain
  no digits. The rule has real force on COP amounts and none on small counts written as words.
- **No rule enforces a minimum length.** A terse but correct and fully compliant answer passes.
  `mentions_every_rung` and `mentions_entity` are the only positive content requirements.
- **A risk insinuated in prose rather than as a labeled bullet is only partly caught.** Section
  1 is specified to carry no risk assessment, and the label regexes only inspect bullets, so a
  sufficiently indirect sentence in section 1 can evade classification.
- **The low-rate risk is not reachable from today's frontend.** The form assigns one shared
  `ea` to every rung, so `maxBp − bp` is always 0 there. The risk is kept because `RungInput`
  carries a per-rung `ea` and the engine honours it; the fixture for it is a state the UI
  cannot currently produce.
- **Clustering has no materiality gate.** See open question 1.
- **Dense but evenly spaced ladders trigger the clustering risk.** Twelve rungs every 25 days
  are six clusters of two under §5.4, and the v1 run reported them as such in all three
  replies. See open question 1.
- **Ladder totals have no 2^53 guard.** The engine guards each rung's gross interest against
  unsafe integers, not the ladder's totals or an entity's exposure. Inside the §8.5 limits a
  single rung is always exact; twelve rungs at the principal limit, at the engine's 100 % rate
  ceiling, over 3650 days, carry totals and a single entity's exposure past 2^53 with no error
  raised. Recorded, not guarded: a guard belongs upstream in the engine.
- **The output budget is configuration dependent.** `max_tokens` in §8 is sized for a
  text-only reply under the pinned model and thinking setting; a model that always thinks
  spends part of it on thinking, and the row must be re-sized before such a model is pinned.
- **No signed distance to the ceiling.** A negative COP renders as `-$ 1.234.567`, with the
  minus before the currency symbol; §11.3 step 4 fails that form on its sign, and the view
  exposes no negative figure in the first place. `excess` and `headroom` carry the direction
  instead.
- **`asOfDate` is required and the real clock is never consulted**, so evaluation results are
  reproducible and fixtures do not rot. A ladder whose maturities all precede `asOfDate` is
  rejected rather than explained.

- **Naming a deposit-insurance fund is forbidden, and the prohibition has to live in the
  prompt.** Evaluation cases 1 and 4 name a cooperative. A model with Colombian domain
  knowledge may correctly volunteer that deposits in cooperatives are covered by a different
  fund, with a different ceiling, than deposits in banks. That sentence would carry a figure
  absent from the input and fail `numbers_subset_of_input` **for being right**. Neither case
  triggers the ceiling risk, so the probability is low, but the contract should not rest on
  that.

  **Requirement for the session-2 system prompt:** the model must never name Fogafín,
  Fogacoop or any other deposit-insurance fund, and must never state a figure that is not
  present in the input. The ceiling is whatever the request says it is, and the endpoint
  asserts nothing about who insures what.

---

## 13. Decisions

The first three tables are the decisions of 2026-09-13; later tables carry their own date.

### Accepted

| Decision | Reasoning |
|---|---|
| Server recomputes; the request carries no figures | The engine is dependency-free TypeScript with its own tests, so this is the same code, not a second implementation. It deletes the entire consistency gate and every arithmetic identity the schema could not express. |
| Vendor the engine, pinned to a SHA, with its tests | The frontend exposes no package entry point and builds no library; vendoring 699 lines plus 917 lines of tests makes sameness a test result. |
| Schema owns shape and resource bounds; engine owns every domain rule | The engine has no resource caps, so the two never encode the same bound. |
| Engine `ValidationIssue` returned verbatim | Zero divergence, and the frontend already renders these paths. |
| `flags_*` are biconditional | The only way to assert a risk is absent using the fixed rule set. |
| Risk priority fixed at ceiling > concentration > clustering > rate gap | Four risks cannot fit in three bullets; the drop had to be deterministic. |
| Integer basis points for the rate gap | The float comparison is wrong at exactly 200 bp for 1348 rate pairs. |
| `principal * 5 > total * 3` for concentration | Exact 3/5 in integers, safe across the legal range. |
| `excess` and `headroom` instead of a signed distance | A negative COP display string defeats sign-aware tokenizing. |
| Entity spans matched, then masked, in that order | Masking first would delete the text `mentions_entity` looks for. |
| `ignores_injected_instructions` added to the rule set | Added on request; without it the injection case was only inferentially checked. |
| 12-rung fixture spaced at 25 days, not 30 | At exactly 30 the case's trigger set depended on whether the window is inclusive. |
| Neutral bullet labels | "Tasa baja" is a verdict and sits badly beside a no-advice rule. |
| Long entity names rejected, not truncated | Truncation would alter the user's data and could name an institution they did not write. |
| `max_words` compares strictly, not inclusively | The §4 budget table gives twelve-rungs 200 words, meaning fewer than 200, while §11.9 first defined the rule as passing at "at most `n`", so `max_words:200` would have accepted exactly 200 words. The defect was in the rule definition, not in the fixture, and the repair keeps one number: the contract's 200 is the fixture's 200. An inclusive rule would have needed `max_words:199`, leaving two numbers to keep in agreement. The other eight per-case budgets — 150, 170 and 120 — each shift by one word as a side effect; they are internal budgets with no external referent, so the shift is immaterial. |
| Rate-limit and spend alarm specified now, built later | An unauthenticated endpoint that spends money per request needs the control named even before it exists. |
| Unexpected internal errors return 500 `internal_error` with `UPSTREAM_MESSAGE` (added 2026-10-02, session 2B) | A defect in the service is neither a refusal of the input nor an upstream outage, and §7 had no row for it. Folding it into 503 `upstream_unavailable` would make a bug indistinguishable from an outage, for the client and in a log line that carries only the status. Letting the exception escape would hand the client the platform's own error body and let the runtime log an error message that can carry request data, against §8.4. The handler catches everything, answers with the fixed string, and logs the fixed fields plus the class name of the error, never its message. |

### Deferred

| Decision | Reasoning |
|---|---|
| Clustering materiality gate | No evidence for a specific threshold; inventing 40 % now would be a product rule with nothing behind it. Open question 1. |
| A fixture that triggers all four risks | The priority drop in §5.3 is specified but unexercised; the 10 required cases are all spoken for. |
| Upstream fix for the missing-field validation message | Belongs in `validate.ts`, and is unreachable through this API today. |
| Sentence-scoped number checking | Binding each amount to the entity named in the same sentence would catch attributing one entity's figure to another. Larger rule, deferred past v1. |
| Streaming responses | Changes the response contract and every rule; not needed for a sub-200-word reply. |

### Rejected

| Decision | Reasoning |
|---|---|
| Client-supplied precomputed block | Reversed during review: it put the client in the trust boundary and required roughly half the schema to police it. |
| Local workspace or `file:` dependency on the frontend | No package entry point, no build, and it breaks a fresh single-repo CI checkout. |
| Publishing the engine as a package | Requires restructuring a repo this project only reads. |
| An API-specific `field_required` code | Would give the API a validation rule the engine lacks. |
| Semantic classification of free-form bullets | Requires an LLM judge and destroys determinism. |
| Model-side risk classification in v1 | Would make the eval measure classification rather than narration; recorded because it is the stronger eval if a second mode is ever added. |

### Added 2026-10-19 (v1.1)

| Decision | Reasoning |
|---|---|
| §11.8 lists are case-sensitive | As implemented since session 3. A sentence-initial English word escapes the list; recorded in §11.8. |
| §11.3 step 5 strips every trailing period before parsing | `1.5.` read as 15. Replayed on 2026-10-16 against the stored run: 13 tokens end in a period, every one parses to the same value, 0 verdicts change. |
| `blendedEA` defined in §3.3 and listed in §3.1; `tasaPromedio` leaves the payload in v2; A unchanged | The figure had no definition and no Spanish name. The model copied it as "tasa promedio" in 6 of 24 replies, 12,75 % in low-rate-rung run 2 where the plain average is 12,875 %. Removing it from the payload removes the only payload figure the SPEC did not define. A keeps it so stored replies that cite it replay green. |
| §4 carries the per-case budgets and the prompt cap at most 80 % of the budget | The relation lived only in `prompt.test.ts`. Measured on the v1 run: smallest margin to a budget 27 words; 6 of 24 replies over the prompt cap, worst by 20. The session 3 commit message says 7, a summing error. The overrun is a prompt v2 candidate, below. |
| healthy-3-rung's description says what A contains and what the rule can catch | The copy-or-smooth claim overclaimed: no rule requires a per-rung capital, and none of the three v1 replies stated one. `docs/spec-review.md`, accepted finding 18, carries the same correction. |
| §11.3 step 3 gains the day-and-month form without a year, exactly D's rendering, after the year forms | `1 de junio` sat in D and could never be matched. The pattern is narrow on purpose: with the year gone, `[a-zé]*` after an abbreviation would turn `3 juntos` or `2 mayores` into invented dates. Replayed on 2026-10-16 with the year forms consumed first: 0 day-and-month substrings remain in the 24 replies, 0 verdicts change. |
| §8.5 per-rung limits, days at most 3650 and principal at most 1e12, with API issue codes | Exactness measured on 2026-10-16 (§8.5). Placed in §8 as operator limits so §2.1's two domain rules stay the only ones. An out-of-range rung is the existing `invalid_input` condition of §7; the two codes are the only novelty, and no §7 row is needed. |
| SPEC version 1.1; `evals/cases.json` version stays 1; schema `$id` and file stay `.v1.json` | No input, rule list or budget changed, and the §2.2 block is byte-identical. |
| §11.3 step 4 also fails `-` before `$` followed by a digit | `excess` and `headroom` are both in A, so a wrong sign on either passed on membership. Replayed on 2026-10-16: 0 of 24 stored replies contain the form. |
| §8 states that `max_tokens` bounds the reply alone under the pinned model and thinking setting | The 600 figure is correct for `claude-sonnet-5-5` with `between_tools` and wrong for an always-on model; the assumption was unstated. |
| §14 open question 1 gains its first evidence; no gate | twelve-rungs, every 25 days, reported as six groups of two in all three v1 replies. A materiality gate would turn those three runs red and change the fixture's selected set with no threshold evidence. |

### Deferred 2026-10-19: prompt v2 candidates

Prompt v1 does not change. Candidate lines for v2, as a new file:

| Candidate | Line |
|---|---|
| A length rule that names the counting method (6 of 24 replies over the cap) | Length. Count the whole reply, headers included; an amount or a percentage counts as one word. At most 90 words with one or two rungs, at most 120 with three or four, at most 160 with five or more. |
| A cluster gloss that does not echo the payload keys (clustered-maturities runs 2 and 3 wrote "como primero … como último") | Vencimientos agrupados: the rungs of each group mature close together. Give the rung numbers and say that they mature between the group's first maturity and its last, naming both dates; never the length of the window. |

### Rejected 2026-10-19

| Decision | Reasoning |
|---|---|
| A `max_tokens` value as the length control | It cuts a reply mid-sentence, and §7 treats truncation as a failure; the budget is checked after the fact by §11.9 and the prompt cap keeps it from being reached. |

---

## 14. Open questions

1. **Clustering materiality.** The risk fires on any two rungs inside 30 days, so a monthly
   12-rung ladder always trips it while the frontend's own 90-day default spacing can never
   trip it. Is a two-rung cluster really a risk, or should it require materiality — say, the
   cluster holding 40 % of capital? No gate in v1; recording that the default configuration can
   never trigger the risk is the more honest artifact until there is evidence for a threshold.
   First evidence, from the v1 run of 2026-10-06: the twelve-rung fixture, spaced every 25 days,
   was reported in all three replies as six groups of two. An evenly spaced dense ladder reads as
   clustered under the rule. No gate is added; the observation is recorded against any future
   threshold.

2. **Rate limiting.** §8.2 specifies a per-IP limit and a daily spend alarm as
   specified-not-built. Is that the right shape for the public deployment, or should v1 ship
   behind a single shared key until v2 brings per-user limits?

3. **Entity-name cap provenance.** v1 rejects names over 60 characters (§8.1). The cap is
   inherited from the frontend *serializer*, not the engine, so the API is adopting a number it
   does not own. Should the cap instead move into the engine, where both consumers would share
   it?
