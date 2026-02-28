# Decisions Log

## Skill Name
- **Chosen**: `origin-source-finder-cskill`
- **Reason**: clear scope + `-cskill` naming convention for discoverability.

## Architecture
- **Chosen**: Simple Skill (single SKILL.md + references)
- **Reason**: single responsibility (source provenance tracing), no multi-agent orchestration needed.

## Dependency Strategy
- **Chosen**: web search must use `brave-search` skill
- **Reason**: lightweight, deterministic, no browser automation overhead.

## Source Ranking Strategy
- **Chosen**: weighted scoring (originality, authority, temporal support, citation graph)
- **Reason**: balances “earliest” with “most authoritative primary publication”.

## Confidence Policy
- **Chosen**: High / Medium / Low with caveats
- **Reason**: prevents false certainty in ambiguous source chains.

## Fallback Policy
- **Chosen**: explicitly return “no single reliable origin confirmed” when evidence is insufficient.
- **Reason**: avoids hallucinated source attribution.

## Activation Design
- **Chosen**: 3-layer activation (keywords + regex patterns + usage/test queries)
- **Reason**: better trigger recall and precision for varied phrasing.
