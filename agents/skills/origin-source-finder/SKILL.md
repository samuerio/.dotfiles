---
name: origin-source-finder
description: Find the most original source of a claim, quote, screenshot, statistic, or breaking news item and return verifiable source links with confidence and evidence trail.
---

# Origin Source Finder Skill

## Purpose

Use this skill when a user asks where a message, claim, quote, screenshot, data point, or news item originally came from.

The objective is not just to find *a* link, but to identify the **most likely primary/original source** and provide a transparent evidence trail.

---

## Mandatory Dependency

This skill must use **brave-search** for all web discovery and extraction work.

- Required: `brave-search` skill for web search and content extraction.
- Do not rely on unsupported browser workflows when brave-search can complete the task.
- If brave-search is unavailable, explicitly say verification confidence is reduced.

---

## When to Use

Activate this skill when the user asks any of the following:

- “What is the original source of this?”
- “Where did this message come from?”
- “Who first published this news/claim?”
- “Give me the primary source link.”
- “Trace this quote/statistic to its origin.”
- “Find earliest reliable source.”

Typical inputs:

- Viral social posts
- Screenshots with unclear provenance
- Reposted news summaries
- Secondary media references to reports
- Quote cards and unattributed statements
- Claimed statistics without citation

---

## When NOT to Use

Do not activate for:

- Pure opinion debates without source tracing intent
- Code debugging / local engineering tasks
- Requests that only need a summary, not provenance

---

## Core Output Contract

Every final answer must include:

1. **Most likely original source** (title + direct URL)
2. **Why this is likely original** (3-5 concrete reasons)
3. **Alternative candidates** (2-5 URLs)
4. **Confidence** (`High` / `Medium` / `Low`)
5. **Caveats / unresolved uncertainty**

If no reliable origin is found, say so clearly and provide best-available candidates.

---

## Source Priority Framework

Rank candidate sources using this priority:

1. **Primary publisher artifacts**
   - Official press release page
   - Original paper/report dataset page
   - Official transcript/video from source institution
2. **Original author channels**
   - Verified account post by the speaker/organization
   - First-party blog/newsroom publication
3. **Authoritative first reporting**
   - Credible newsroom that first broke the story with direct evidence
4. **Secondary aggregation and reposts**
   - News digests, SEO reposts, social mirrors

Important:

- Earliest timestamp alone is insufficient.
- Authority + authorship + evidence context must be checked together.

---

## Investigation Protocol

### Step 1 — Parse the user claim

Extract:

- Named entities (person/org/location)
- Unique phrases (exact quote fragments)
- Claimed date/time window
- Content type: quote / screenshot / statistic / event / policy / rumor

Normalize terms:

- Expand abbreviations
- Generate English variants
- Include spelling variants and aliases

### Step 2 — Build query set

Construct at least 4 query families:

1. **Exact phrase query**
2. **Entity + key claim query**
3. **Site-scoped query** (`site:official-domain`)
4. **Time-constrained query** (month/year, earliest references)

For screenshots/claims with low text:

- Query distinctive text fragments
- Query mentioned handles/usernames
- Query any visible numeric claim

### Step 3 — Run brave-search rounds

Use brave-search iteratively:

- Round A: broad discovery (collect candidates)
- Round B: authority-focused search (official domains first)
- Round C: earliest evidence search (time validation)
- Round D: contradiction search (“debunk”, “correction”, “updated”) if needed

### Step 4 — Candidate scoring

Score each candidate with weighted factors:

- **Originality (0-40)**: first-party artifact vs repost
- **Authority (0-25)**: institutional credibility / verified identity
- **Temporal support (0-20)**: earliest reliable timestamp + archive consistency
- **Citation graph (0-15)**: whether others cite this page as root source

Total score = 100.

Decision rule:

- 80+ → likely original source (`High` if no strong conflicts)
- 60-79 → plausible primary candidate (`Medium`)
- <60 → insufficient evidence (`Low`)

### Step 5 — Conflict resolution

If multiple candidates conflict:

- Prefer direct first-party artifact over media paraphrase
- Prefer pages with stable publication metadata
- Prefer sources cited by independent outlets
- Flag if earliest page was updated or replaced

### Step 6 — Response generation

Return concise, structured report with links and trace logic.

---

## Evidence Quality Labels

Use these labels internally and optionally surface them:

- **Grade A**: First-party source, direct publication, verifiable timestamp
- **Grade B**: Strong secondary source citing first-party material
- **Grade C**: Weak source or unverified chain

Never present Grade C as definitive origin.

---

## Output Template (English)

```text
Most likely original source:
- <Title> — <URL>

Why this is likely original:
- <Reason 1>
- <Reason 2>
- <Reason 3>

Alternative candidates:
- <URL 1>
- <URL 2>

Confidence: <High|Medium|Low>

Caveats:
- <What is still uncertain>
```

---

## Special Cases

### 1) Quote attribution

- Search exact quote + speaker + earliest date
- Check transcript/interview/full speech first
- Avoid quote websites as primary unless they point to transcript

### 2) Screenshot provenance

- Extract all visible text fragments
- Search phrase clusters, not only one line
- Validate if screenshot is cropped/edited by finding full context page

### 3) Statistical claims

- Locate official dataset/report table first
- Confirm metric definition, period, and geography
- Reject derivative blog claims without original table link

### 4) Breaking news

- Distinguish first rumor post vs first verified publication
- Prefer official statement / document over social hearsay

### 5) Multi-language chains

- Use English anchor terms plus original-language entity names where needed
- Confirm translation drift before declaring origin

---

## Failure / Degraded Mode

If evidence is weak:

- Say “No single reliable original source could be confirmed.”
- Provide best candidates with confidence `Low`.
- Explain what additional evidence is needed (full screenshot, exact date, full quote).

Never fabricate origin links.

---

## Performance and Reliability Rules

- Limit to high-signal sources first (official domains, known outlets)
- Avoid overfitting to one search hit
- Always cross-check at least 2 independent sources before `High` confidence
- Track and disclose unresolved contradictions

---

## 10 Example User Prompts

1. “Find the original source of this quote and link it.”
2. “Who first published this claim?”
3. “This screenshot is viral. Where did it come from?”
4. “Give me the primary source for this statistic.”
5. “Trace this rumor to earliest reliable publication.”
6. “Is this statement real? show source URL.”
7. “I saw this in a repost, what’s the origin?”
8. “Find the first official announcement link.”
9. “What is the source chain for this claim?”
10. “Give me original citation, not media summaries.”

---

## 10 Example Response Patterns

### Example A — Clear first-party source

- Original source found on official domain
- Two major outlets cite it
- No timestamp conflict
- Confidence: High

### Example B — Competing early reports

- Two outlets report near-simultaneously
- One cites official document; the other does not
- Prefer cited one as top candidate
- Confidence: Medium

### Example C — No reliable origin

- Only reposts and social references
- No first-party artifact found
- Provide candidates with caveat
- Confidence: Low

---

## Safety and Integrity

- Evidence over certainty: if uncertain, say uncertain.
- Do not infer authenticity from virality.
- Do not claim “original source” without explicit rationale.

---

## Maintainer Notes

- Keep activation phrases updated as user query styles evolve.
- Periodically refresh source-priority examples.
- Add domain-specific heuristics if repeated use cases emerge (health, geopolitics, finance).
