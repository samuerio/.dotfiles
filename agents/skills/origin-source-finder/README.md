# origin-source-finder-cskill

Find the most original source of a claim, quote, screenshot, statistic, or breaking news item and return verifiable source links with confidence and evidence trail.

## What this skill does

- Traces claims to likely primary/original sources
- Uses brave-search for web discovery and extraction
- Returns source links with reasoning and confidence
- Handles ambiguous cases with explicit caveats

## Install

From repository root:

```bash
/plugin marketplace add ./origin-source-finder-cskill
```

## Dependency

This skill expects `brave-search` skill to be available for web search.

## Usage examples

- "Find the original source of this quote and give me the link"
- "Where did this screenshot come from originally?"
- "Who first published this news?"
- "Trace this claim back to primary source"
- "Give me the earliest reliable source URL"

## Output format

- Most likely original source (title + URL)
- Why this is likely original (3-5 bullets)
- Alternative candidates (URLs)
- Confidence (High/Medium/Low)
- Caveats

## Files

- `SKILL.md`: behavior spec and tracing protocol
- `.claude-plugin/marketplace.json`: install + activation config
- `DECISIONS.md`: architecture and ranking decisions
- `references/methodology.md`: scoring and conflict resolution
- `references/test-cases.md`: validation scenarios
