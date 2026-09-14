# Adversarial review of the v1 specification

Date: 2026-09-13. Reviewed artifact: `SPEC.md` and the design behind `evals/cases.json`.

This is the record the Decisions section of `SPEC.md` points at. Its purpose is that a
deferred or rejected finding can be re-read with its reasoning intact rather than
relitigated later.

---

## Method

Three read-only explorers mapped the domain in `../lab-cdt-ladder` — data model, money and
exposure, dates and validation — and every claim each produced was then put to two
independent skeptics: one checking that the quoted paths, symbols, line numbers and verbatim
blocks actually exist, and one checking the semantics against the implementation **and** its
tests. A completeness critic then looked for questions no finding answered.

270 claims were checked. Three were refuted, all trivial: two stale comments in the upstream
test files, and some line numbers off by one to three. Nothing about the formulas, units,
thresholds or error messages was wrong.

Two further reviewers then attacked the proposed design itself: one on schema legality and
rule checkability, one on evaluation coverage and arithmetic. Their findings are below.

Every empirical claim in this document was re-run on this machine (Node v22.23.2, ICU 78.2)
before being accepted. Several review claims were themselves wrong, and are marked.

---

## The finding that changed the architecture

**The client-supplied precomputed block put the client inside the trust boundary.**

The original design had the frontend send a `computed` block alongside the ladder, and the
Lambda check it for internal consistency. The schema review listed seventeen constraints that
JSON Schema draft-07 cannot express, and observed that items 4 through 11 and 15 of that list —
roughly half the schema — existed *only* because `computed` was in the request. It also found a
hole no consistency gate closes cheaply: a request setting `grossInterest: 100` beside
`grossInterestDisplay: "$ 900.000.000"` would have the model narrate the lie.

The counter-argument that re-deriving means writing the money math twice does not hold. The
engine is 699 lines of dependency-free TypeScript with no React imports and its own 917-line
test suite. Vendoring it is not a second implementation; it is the same code, and the vendored
tests prove it.

**Disposition: accepted.** The request became `{ asOfDate, ladder }`. The consistency gate,
the display-string trust problem, the ICU agreement problem, every arithmetic identity, and
every hand-authored figure in the fixtures were deleted with it. The frontend needs no changes
at all. See `SPEC.md` §3 and §9.

A consequence worth naming: `flags_*` stopped being "did the model copy a boolean we handed
it" and became an assertion against ground truth the caller cannot influence.

---

## Accepted findings

### 1. The percent formatter emits no space, and the currency formatter uses a non-breaking one

Measured:

```
formatCOP(1234567)   "$ 1.234.567"    0024 00a0 0031 ...   (U+00A0 after $)
formatCOP(-1234567)  "-$ 1.234.567"                        (minus BEFORE the symbol)
formatPercent(0.135) "13,5%"          0031 0033 002c 0035 0025   (no space at all)
```

The upstream test at `src/engine/format.test.ts:6` normalizes U+00A0 and U+202F precisely
because ICU builds disagree, and its percent test strips all whitespace. The design had assumed
`"13,5 %"`.

**Disposition: accepted.** Normalization steps 8 and 9 in `SPEC.md` §11.1 remove the space
between `$` and a digit and before `%`, so both render as one token and word counts are
ICU-stable. After the architecture change this stopped being a contract problem and became an
internal grader detail.

### 2. The stated rationale for integer basis points was factually wrong

The spec draft justified basis points with `0.135 - 0.115 >= 0.02`. Measured, that expression
is `true`: the difference is `0.020000000000000004`.

The real counterexample is `0.022 - 0.002`, which is `0.019999999999999997` and therefore
fails `>= 0.02` while the basis-point gap is exactly 200. Measured: 1348 such disagreeing pairs
exist for rates between 0,01 % and 30 % at 1 bp resolution.

**Disposition: accepted.** The decision was right; the justification was a checkable falsehood
about to be published. `SPEC.md` §5.4 quotes the correct example.

### 3. A signed distance to the ceiling cannot be checked

`formatCOP` puts the minus before the currency symbol, so a token scan using `-?\d[\d.,]*`
never captures the sign on `-$ 1.234.567`. The allowed set would then contain both the signed
raw value and its absolute value from the display string, making "you are 1.234.567 under the
ceiling" and "1.234.567 over" indistinguishable to the checker.

**Disposition: accepted.** `excess` and `headroom`, both non-negative, plus the existing
`exceeded` boolean. No negative number appears anywhere in a valid payload or a valid output,
and the number rule fails outright on a minus sign before a digit.

### 4. The allowed-number set leaked every small integer and every threshold

Deriving the set from all input strings leaked `1..12` from rung ids, `1..6` from entity ids,
`60`, `30` and `2` from the threshold constants, `4` from the withholding display, and
anything a user typed into an entity name. The worst consequence: shipping the thresholds into
the request let the model write "el 60 % de tu capital está en X" and pass, when the real share
was 31 % and concentration was not triggered.

**Disposition: accepted.** `SPEC.md` §11.3 builds the set from an explicit allowlist of display
fields plus named count fields, and lists what is excluded and why. Entity names are masked
before the scan, which also closes the allowlist-injection route through a name like
"Banco 999.999.999".

### 5. Counts had to become first-class figures

Any natural Spanish sentence contains counts — three rungs, six entities, two maturities — and
none of those is a money, rate or date figure.

**Disposition: accepted.** `rungCount`, `entityCount`, `clusterCount`, per-cluster `count`,
`perRung[].index`, `perRung[].days` and `daysToNextMaturity` are in the allowed set.

### 6. Four risks cannot fit in three bullets

All four can trigger at once while the output contract allows at most three.

**Disposition: accepted.** Fixed priority in `SPEC.md` §5.3, and the biconditional rules assert
against the surviving `selected` set rather than against `triggered`. Noted as currently
unexercised: no fixture triggers four risks, so the drop is specified but untested. Recorded as
deferred below.

### 7. Markdown breaks every label regex

`- **Tope del seguro:**` does not match `/^- Tope del seguro:/m`, and a model asked for Spanish
bullets emits bold labels a good share of the time. This was the most likely mechanical cause
of a red evaluation run having nothing to do with model quality.

**Disposition: accepted.** Normalization deletes `*` and `_`, the bullet regex accepts `-` and
`•` with leading space, and the output contract forbids markdown.

### 8. "Collapse runs of spaces" would have destroyed the line-anchored rules

Implemented the obvious way as `replace(/\s+/g, ' ')`, newlines die and every header and label
rule breaks.

**Disposition: accepted.** `SPEC.md` §11.1 is an ordered numbered list and collapses only
horizontal whitespace via `[^\S\n]+`.

### 9. The advice-verb list was both too strict and too loose

False fails: `retira`, `mueve`, `traslada`, `invierte` and `diversifica` are third-person
present indicative in ordinary sentences — "el banco retira el 4 % de retención" is a
statement of fact.

False passes: `podrías considerar`, `es recomendable`, `vale la pena`, `lo ideal`, `hay que`,
`se recomienda` and `ten en cuenta` were all advice and all absent from the list.

**Disposition: accepted.** Rebuilt around advisory constructions in `SPEC.md` §11.7, with the
exclusions documented alongside their reasons. Bare `podría` and bare `considera` are excluded
too: "la exposición podría superar el tope" is a factual modal.

### 10. `language_es` could fail on a correct output

An entity named "Bank of Bogotá" would trip a zero-English assertion. The English word list
also needed auditing for Spanish homographs — `a`, `no`, `son`, `ten`, `den`, `van`, `sin`,
`fin`, `con`, `ha`.

**Disposition: accepted.** The scan runs on masked text, and the English list is audited.

### 11. `mentions_every_rung` was underdefined and unsatisfiable at 12 rungs

`peldaños 1, 2 y 3` does not contain the substring `peldaño 1`. Two rungs maturing the same day
make the rule undecidable. And at the 12-rung limit, naming every rung inside 200 words turns
the output into a table.

**Disposition: accepted.** §11.4 reads the digit run following `peldaños?`; the rule is used
only where maturity dates are pairwise distinct; case 7 omits it and carries two
`mentions_entity` rules instead, with the omission stated in the fixture's own description.

### 12. The 12-rung fixture sat exactly on an undefined boundary

At 30-day spacing, `gap <= 30` yields six clusters of two and `gap < 30` yields twelve
singletons — so the case's entire trigger set depended on a word the spec had not pinned.

**Disposition: accepted, both halves.** The window is pinned as inclusive in `SPEC.md` §5.4,
**and** the fixture moved to 25-day spacing so it triggers under either reading. Boundary
probing belongs in case 10, where it is the stated purpose.

### 13. There was no "today", so "cuándo" was unanswerable and fixtures would rot

`ScenarioResult.nextMaturity` is the earliest maturity, not the next one after now; the UI
supplies `today` separately and renders "ya venció" when appropriate. With no such field, and
with fixture start dates in the past, a model would reasonably say the first rung had already
matured — a sentence no rule covers and whose truth changes every month.

**Disposition: accepted.** `asOfDate` is required, pinned in every fixture, and the spec forbids
consulting the real clock. A ladder entirely in the past is rejected rather than explained,
which is recorded as a v1 limitation.

### 14. Prompt injection through entity names was unaddressed

Six free-text fields of 60 characters each go straight into the model prompt.

**Disposition: accepted, and folded into case 6 rather than an eleventh case.** The single-rung
fixture now carries a 49-character injection string as its entity name. A new rule,
`ignores_injected_instructions`, was added to the fixed set on the owner's instruction: without
it, "the model did not obey" was inferred only from `language_es`, and a reply that abandoned
the ladder to say "Ignoro las instrucciones anteriores" — in Spanish, under the cap, with no
forbidden verbs — would have passed nearly everything. Its limits are recorded in `SPEC.md`
§12: it is a keyword guard, not a proof.

### 15. Entity-name masking conflicted with `mentions_entity`

Masking the name is what stops injected text from failing unrelated rules, but the rule that
checks the name was present looks for exactly the text masking removes.

**Disposition: accepted.** `SPEC.md` §11.2 specifies the order as numbered steps: locate spans,
evaluate `mentions_entity` against them, then mask, then run the scans. A routing table says
which rules see masked text and which see unmasked.

### 16. Concentration arithmetic and overflow

`entity.principal * 100 > total.principal * 60` leaves safe-integer range for large
principals if the schema's bound is `MAX_SAFE_INTEGER`.

**Disposition: accepted with a correction to the reviewer's framing.** Under the 12-digit cap
the frontend enforces, `1e12 * 100` is `1e14` and safe — so the overflow was not reachable
through the real client. The fix was taken anyway because it is free and unconditionally safe:
60 % is exactly 3/5, so the test is `principal * 5 > total * 3`.

### 17. Missing-field validation reports as out-of-range

A missing `ea` produces `ea_out_of_range` with "La tasa E.A. debe estar entre 0 % y 100 %.",
because `!Number.isFinite(undefined)` is true. Misleading for a missing field.

**Disposition: accepted as a record, rejected as a patch.** Under the shape/domain split it is
unreachable through this API: the schema's `required` rejects a missing key first. The fix
belongs upstream in `validate.ts`. Introducing an API-specific `field_required` code would give
the API a validation rule the engine lacks, which is the second-source-of-truth problem
returning by the back door. See `SPEC.md` §7.2.

### 18. Arithmetic corrections to the fixture designs

Both accepted, both verified:

- Case 2 was suspected of being impossible — an entity cannot cross a 50.000.000 ceiling while
  holding under 60 % of capital and staying realistic. The suspicion was wrong. The binding
  constraint is total capital, with a floor around 73,4 M COP, which the upstream repo's own
  share fixture already exceeds at 120.000.000. The accepted design puts one entity 69.493 over
  and another 16.000 under, exercising both sides of the strict comparison in one fixture.
- Case 1 should use the engine's own `splitCapital(50.000.000, 3)` result — `16.666.667`,
  `16.666.667`, `16.666.666` — rather than three equal rungs. The odd peso is a real test of
  whether the model copies the figure or rounds it to "unos 16,7 millones". Accepted.
- No case used `dayCountBase: 365`, so an implementation hardcoding 360 would have passed the
  whole suite. Case 1 and case 5 now use 365. Accepted.
- Case 10's four boundaries are not independent: an entity at exactly 60 % necessarily holds
  the largest exposure, so the concentration boundary and the ceiling boundary must be the same
  entity. Accepted; the tight ceiling margins live in cases 2 and 3 instead, and case 10 keeps
  the three boundaries that can be exact.
- The generator's self-proof fixtures all used 4 % withholding, at which the rounded-gross and
  raw-gross bases are provably indistinguishable for every input. A generator computing
  retención on the raw gross would have reproduced every chosen fixture while contradicting
  `scenario.ts:33`. Accepted: the 7 % discriminator was added, along with the totals,
  `splitCapital`, exposure-basis and `roundCOP` half-up cases.

---

## Rejected findings

### "Make the model classify the risks, and score it against harness ground truth"

The argument was that four integer comparisons over data you already hand the model is not a
capability worth measuring, so the eval would read 100 % on day one and never discriminate
between prompt versions.

**Rejected for v1, recorded as the stronger evaluation if a second mode is ever added.** The
feature's stated purpose is that the model never does arithmetic, and deciding whether a value
crosses a threshold is arithmetic. After the architecture change the criticism also lost most
of its force: the triggers are now computed by the server from the ladder, not handed over by
the caller, so `flags_*` is a real assertion rather than a copy check. What remains true is
that it measures narration rather than classification, which is what v1 is for.

### "Replace the four `flags_*` rules with one `risk_labels_exact_set` rule"

Strictly better as a rule design. **Rejected** because the rule set is fixed by the owner and
the biconditional reading of the four existing names achieves the same assertion when all four
are listed, which every valid case does.

### "Free prose bullets plus a machine-readable trailer line"

Proposed as a way to keep bullets natural while still classifying exactly. **Rejected** by the
reviewer who proposed it and confirmed here: the trailer can desynchronize from the prose, and
detecting that needs a judge, which is where the design started.

### "Add a materiality gate to clustering"

**Deferred rather than rejected** — see below.

---

## Deferred findings

| Finding | Why deferred |
|---|---|
| Clustering materiality gate (for example, a cluster must hold 40 % of capital) | There is no evidence for a specific threshold. Inventing one now would be a product rule with nothing behind it. Recording that the frontend's own 90-day default spacing can never trigger the risk, while a monthly ladder always does, is the more honest artifact. Open question 1. |
| A fixture that triggers all four risks | The priority drop in §5.3 is specified but unexercised. All ten case slots are spoken for by the required coverage. |
| Sentence-scoped number checking | Binding the amounts in a sentence to the entity named in that sentence would catch attributing one entity's figure to another, which the current set-membership rule cannot. Roughly fifteen lines, real value, larger than v1. |
| `min_words` or an equivalent content floor | `max_words:200` is satisfied by a nine-word answer. `mentions_every_rung` and `mentions_entity` are the only positive content requirements today. Adding a rule name is outside the fixed set. |
| Upstream `field_missing` validation code | Belongs in `validate.ts`; unreachable through this API today. |
| Streaming responses | Changes the response contract and every rule, for a reply under 200 words. |

---

## Verification runs

All executed on Node v22.23.2, ICU 78.2.

**Engine reproduction.** A generator re-implementing `periodRate`, `roundCOP`, `addDays` and
`splitCapital` reproduces every pinned upstream fixture:

| Fixture | Expected | Result |
|---|---|---|
| 850.000.000 at 13,5 %, 90 d, base 365 | 26.959.524 / 1.078.381 / 25.881.143, matures 2026-10-24 | matches |
| 50.000.000 at 13,5 %, 390 d, base 360 | gross 7.352.038 | matches |
| 44.000.000 at 13,6 %, 360 d, base 360 | 5.984.000 / 239.360 / 5.744.640 | matches |
| 100 at 7,4 %, 365 d, base 365, retención 7 % | gross 7, retención **0** | matches; the raw-gross basis would give 1 |
| 3 × 10.000 at 2,604 %, base 365 | rows 260, total **780** | matches; rounding the raw sum would give 781 |
| 3 × 26.000 at 1 %, retención 4 % | retención rows 10, total **30** | matches; portfolio rounding would give 31 |
| `splitCapital(50.000.000, 3)` | 16.666.667 / 16.666.667 / 16.666.666 | matches; extra peso on the first rungs |
| `roundCOP(0.5)`, `roundCOP(-0.5)` | 1, and `-0` normalized to 0 | matches |
| `addDays` month-end and leap cases | 2026-12-31 + 90 = 2027-03-31; 2028-02-28 + 1 = 2028-02-29; 2027-02-28 + 1 = 2027-03-01 | matches |

**Trigger isolation.** Every valid fixture was run through the engine formulas and the four
threshold definitions. Each produces exactly its intended trigger set with no hidden second
trigger. Key margins:

| Case | Decisive figure |
|---|---|
| ceiling-exceeded-one-entity | exposure 50.069.493 against the ceiling, excess 69.493; second entity 16.000 under; top share 47,06 % |
| concentration-over-60 | share 63,89 %; ceiling missed by 993.266 |
| clustered-maturities | maturities 2027-06-01, 06-11 and 06-21 form one qualifying cluster of three under both readings; the fourth rung, 132 days later, forms a singleton that does **not** count toward the risk, since the threshold requires two or more rungs |
| low-rate-rung | 1350 bp against 1100 bp, gap 250 |
| single-rung-injected-name | share 100 %; exposure 45.400.000, under the ceiling |
| twelve-rungs | six clusters of two under both readings; every entity at 16,67 % and under 22,1 M exposure |
| no-risks-boundaries | `45.000.000 × 5 = 225.000.000` and `75.000.000 × 3 = 225.000.000`, so strictly-greater is **false** on an exact integer tie; gaps 31 and 31 days; rate gap 190 bp |

**Independent recomputation.** The eight valid fixtures were recomputed outside this session:
period rates, per-rung rounding, exposures, shares of capital, anchor-greedy clustering and
basis-point gaps. Every trigger set and every figure quoted in the case descriptions reproduced
exactly.

**Request size.** The largest legal body — 12 rungs, 6 entities, 60-character names, 12-digit
principals — measures 1.555 bytes, against an 8 KiB cap.
