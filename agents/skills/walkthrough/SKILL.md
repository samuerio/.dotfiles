---
name: walkthrough
description: >
  Stress a greenfield design that has no source code yet by walking its primary
  flow and the branches that break it, grounded on design documents and their
  associated artifacts (pseudocode, specs, interface sketches). Surface
  unresolved design decisions as explicit UNDECIDED markers instead of filling
  them in. Use for requests such as "walk through this design", "does this flow
  actually work", "where does this break", or "what am I missing". Works best
  grounded on a written design artifact; if source code already exists, use
  trace instead.
---

# Walkthrough

Stress a design that does not have source code yet.

Never write, modify, or implement the target.

## When not to use this

If the system already has source code, use `trace`. `trace` reconstructs what
code actually does; this walks what a design intends to do. Reconstructing and
intending need opposite contracts, so do not mix them.

## Artifacts

Ground the walk on the written design artifacts the user referenced or
supplied — a design document together with any pseudocode, spec, or interface
sketch associated with it. Follow written associations only:

- the referenced document's own directory,
- relative paths the document cites,
- conventional sibling locations (for example `docs/`, `spec/`, `adr/`,
  `DESIGN.md`).

Never hunt through the repository for "some design doc", and never open source
code to fill a gap — a design that already has code belongs to `trace`.

When several artifacts apply, the more specific one refines the more abstract
one:

```text
pseudocode / interface signatures  >  interface sketch  >  design narrative
```

If two artifacts contradict each other, do not silently pick a winner: record
the contradiction as `UNDECIDED` and restate it in `OPEN QUESTIONS`.

## Grounding

Treat the supplied design artifacts as authoritative for intended control
flow; when several apply, resolve precedence as in `Artifacts`.

Treat documented external semantics (framework, protocol, queue, database
guarantee) as authoritative only when the behavior is really documented. Do not
guess framework behavior; mark it `UNDECIDED`.

Treat user-stated decisions as authoritative.

**Do not fill gaps with assumptions.** This is the rule that most differs from
`trace`. Where `trace` may assume a value to keep the trace moving, this skill
must stop and name the gap, because in a greenfield design an unfilled gap
*is* the finding.

When the walk cannot continue without inventing something, emit:

```text
UNDECIDED: <the question the design does not answer>
  → proceeding as: <the choice made to continue>
```

Every `UNDECIDED` must be restated in `OPEN QUESTIONS`.

Do not chain assumptions. If a second gap depends on a first unresolved gap,
stop that branch there and say so.

## Walking

Walk the primary flow first, chronologically and causally.

Then walk the branches that break it.

Unlike `trace`, untraversed branches are the point. Cover at least:

1. the primary flow,
2. a dependency that is slow, absent, or returns an error,
3. the same operation running twice (retry, duplicate, double submit),
4. two operations running concurrently,
5. empty input and maximum-size input,
6. the path that never terminates or never gets its callback or event,
7. partial failure after a side effect has already happened.

Skip a category only when it is structurally impossible, and say why in one
line.

## Output structure

Sections in order: `DESIGN`, `WALK`, `BREAKS`, `OPEN QUESTIONS`.

Wrap the whole output in a single fenced code block tagged `text`, so `#`
comment lines stay plain text and whitespace is preserved. Output nothing
outside the fence and no prose between sections.

- `DESIGN` — every artifact the walk consults, with its path, or
  `identified from conversation` if none was written down, limited to what the
  walk actually uses.
- `WALK` — the primary flow as causal ASCII, using trace's vocabulary of
  `CALL`, `VALUE`, `MUTATE`, `SIDE EFFECT`, `RETURN`, plus `UNDECIDED`.
- `BREAKS` — one block per failure branch, labeled `[branch: <name>]`, each
  ending in the observable consequence: a `RETURN`, a `MUTATE`, or a named
  failure mode such as lost update, duplicate delivery, deadlock, or unbounded
  growth.
- `OPEN QUESTIONS` — every `UNDECIDED` restated as a question the designer must
  answer, ordered by how early it blocks the flow.

Use `▼` for chronology and `├─` / `└─` for sibling effects, as in `trace`.

Render only what the design actually determines. A short walk that names five
real gaps beats a long walk that reads as settled.

## Language

Write `DESIGN`, `WALK`, `BREAKS`, and `OPEN QUESTIONS` in English.

Keep component, operation, and field names exactly as they appear in the design
artifact.

Respond in the user's language only in the chat reply after saving.

## Example

```text
DESIGN:

submit(order) → reserve stock → charge payment → emit order.created

artifact: spec/orders/plan.md

WALK:

CALL submit(order)
  │
  ▼
CALL reserveStock(order.items)
  │
  ├─ MUTATE stock.reserved: 0 → 2
  │
  ▼
CALL chargePayment(order.total)
  │
  ├─ SIDE EFFECT payment gateway charge
  │
  ▼
UNDECIDED: gateway returns 200 but settlement is async - is the charge
  considered done here?
  → proceeding as: done, since the sketch has no settlement state
  │
  ▼
SIDE EFFECT emit order.created

RETURN orderId

BREAKS:

[branch: charge fails after stock is reserved]

CALL chargePayment(order.total)
  │
  ▼
RETURN error
  │
  ▼
# nothing in the sketch releases the reservation

MUTATE stock.reserved: 2 → 2 (never released)

# failure mode: reserved stock leaks on every failed payment

[branch: submit retried after a timeout]

CALL submit(order)   # second call
  │
  ├─ MUTATE stock.reserved: 2 → 4
  │
  ▼
SIDE EFFECT payment gateway charge   # charged twice

# failure mode: no idempotency key in the sketch

OPEN QUESTIONS:

1. Is payment settled synchronously, or does the flow need a state between
   charged and confirmed?
2. Who releases a stock reservation when charging fails?
3. What idempotency key makes a retried submit safe?
```

## Save

- **The design exists as a written artifact:** save `walkthrough.md` in the same
  directory as the artifact the walk is grounded on — the one the user
  referenced, or the most specific one when several apply (see `Artifacts`).
- **The design exists only in conversation:** save to a timestamped directory:

```text
.pi/walkthrough/[YYYYMMDD-HHMMSS]-[slug]/walkthrough.md
```

Use the timestamp when the skill runs.

Derive `[slug]` from the primary flow in kebab-case.

Overwrite an existing file at the same output path rather than creating a `v2`,
`final`, or similarly suffixed copy.

Before saving, verify:

- every non-`UNDECIDED` line traces to the design artifact, documented external
  semantics, or a user-stated decision;
- every `UNDECIDED` appears in `OPEN QUESTIONS`;
- no assumptions were chained;
- the whole output is a single `text` fence, longer than any run of three or
  more backticks;
- the output path is the grounded artifact's directory when the design exists
  as a written artifact, otherwise the timestamped `.pi/walkthrough/` path.

After writing the file, reply exactly:

> Walkthrough saved - run `code [output-path] &` to review.
