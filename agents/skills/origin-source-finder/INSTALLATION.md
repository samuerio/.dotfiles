# Installation Guide

## 1) Prerequisites

- You are in a Claude Code environment that supports marketplace install.
- `brave-search` skill is installed and available.

## 2) Install this skill

```bash
/plugin marketplace add ./origin-source-finder-cskill
```

## 3) Verify

Ask:

- "Find the original source of this quote and give me the link"
- "Where did this screenshot come from originally?"

You should see structured output with source URL, reasons, alternatives, confidence, and caveats.

## 4) Troubleshooting

### Install command not found
If `/plugin` is not available in your shell, run the command inside Claude Code command interface (not plain bash shell).

### Skill not activating
- Check activation phrases in `.claude-plugin/marketplace.json`
- Ensure question intent is source tracing, not general summary

### Web results weak
- Ensure brave-search skill is installed and operational
- Provide more context: exact quote, date, entity, screenshot text
