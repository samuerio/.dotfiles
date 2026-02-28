# Methodology: Original Source Tracing

## Goal
Identify the most likely original source for a user-provided claim and provide verifiable links.

## Workflow

1. Parse claim into entities + quote fragments + date hints.
2. Build diversified query set:
   - exact quote
   - entity + claim
   - site-scoped queries
   - time-constrained queries
3. Run iterative brave-search rounds.
4. Build candidate table with metadata:
   - URL
   - publisher
   - timestamp
   - cited references
   - content type
5. Score candidates with weighted model.
6. Resolve conflicts and produce final structured answer.

## Scoring Formula

`score = originality*0.40 + authority*0.25 + temporal*0.20 + citation_graph*0.15`

### Originality (0-100)
- 100: first-party official publication
- 70: reputable report citing direct docs
- 40: analysis/commentary
- 10: repost aggregator

### Authority (0-100)
- 100: official institution / verified issuer
- 80: top-tier newsroom
- 50: niche publication with track record
- 20: anonymous repost

### Temporal (0-100)
- 100: earliest verifiable with stable metadata
- 60: early but weak metadata
- 30: uncertain or edited without history

### Citation Graph (0-100)
- 100: widely cited as root source
- 60: cited indirectly
- 20: not cited by independent sources

## Conflict Rules

- Prefer first-party primary artifact over paraphrase.
- If timestamps conflict, prioritize stable metadata + independent citations.
- If earliest source is unreliable, downgrade confidence.

## Output Rules

Always include:
- top source URL
- 3-5 reasons
- alternatives
- confidence
- caveats

If unresolved, explicitly mark as low-confidence.
