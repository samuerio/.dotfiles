# Pseudocode Trace — Worked Examples

These examples strictly follow the format and core principles in SKILL.md — use them to calibrate how much detail to show, when to write `old → new`, and what must never be written.

---

## Example 1: Linear branching (independent IFs stacking state)

```
INPUT: user.level=VIP, order.amount=520, isFirstOrder=false, coupon="SAVE50"

FUNCTION calculateDiscount(user, order):
    baseDiscount ← 0

    IF user.level == "VIP":                  # "VIP" == "VIP"
        baseDiscount ← order.amount * 0.1    # 52

    IF order.amount >= 500:                  # 520 >= 500
        baseDiscount ← baseDiscount + 20     # 72

    IF order.hasCoupon("SAVE50"):            # user.coupons=["SAVE50","WELCOME10"]
        baseDiscount ← baseDiscount + 50     # 122

    finalDiscount ← MIN(baseDiscount, order.amount * 0.5)
                                             # MIN(122, 260) → 122

    RETURN order.amount - finalDiscount      # 520-122 → 398
```

Note: the first-order-bonus branch is absent entirely — `isFirstOrder=false` puts that logic (if it exists in the real function) off this input's execution path. `baseDiscount ← 0` gets no comment: the value is the line itself.

---

## Example 2: Loop with early exit

```
INPUT: qty=100, warehouses=[WH1(stock=80), WH2(stock=50)]

FUNCTION deductStock(qty, warehouses):
    remaining ← qty                          # 100

    FOR wh IN warehouses:
        IF remaining <= 0: BREAK
            # iter 1: 100 <= 0
            # iter 2: 20 <= 0
        deduct ← MIN(wh.stock, remaining)
            # iter 1: MIN(80, 100) → 80
            # iter 2: MIN(50, 20) → 20
        wh.stock ← wh.stock - deduct
            # iter 1: 80 - 80 → 0
            # iter 2: 50 - 20 → 30
        remaining ← remaining - deduct
            # iter 1: 100 - 80 → 20
            # iter 2: 20 - 20 → 0

    IF remaining > 0:                        # 0 > 0
        RETURN "insufficient stock"

    RETURN "success"
```

Note: `wh.stock` and `remaining` persist across iterations, but every previous value is readable — from the INPUT line or from the substituted left operand inside the comment — so bare `computation → result` chains suffice. `deduct` is a fresh per-iteration value, so it gets the computed result only. `old → new` is reserved for mutations whose previous state is not readable anywhere; see Example 4.

---

## Example 3: Guard-clause chain

```
INPUT: creditScore=680, monthlyIncome=15000, debtRatio=0.3, requestAmount=200000

FUNCTION loanApproval(applicant):
    IF applicant.creditScore < 600:          # 680 < 600
        RETURN "rejected - low credit"

    IF applicant.debtRatio > 0.5:            # 0.3 > 0.5
        RETURN "rejected - high debt"

    maxLoanAmount ← applicant.income * 12 * 5
                                             # 15000 * 12 * 5 → 900000

    IF applicant.requestAmount > maxLoanAmount:
                                             # 200000 > 900000
        RETURN "manual review"

    approvedRate ← 4.5 - (applicant.creditScore - 600) / 100
                                             # 4.5 - (680-600)/100 → 3.7

    RETURN {status: "approved", rate: approvedRate}
                                             # {status: "approved", rate: 3.7}
```

Note: every non-triggering guard keeps its line with the substituted condition — `680 < 600` lets the reader run the comparison themselves instead of being told "condition not met".

---

## Example 4: Field state mutation

```
INPUT: now=14:30, lastActive=14:05, timeoutThreshold=20min, rememberMe=false
       (session.status is not in the input — its current value is visible nowhere
        outside this trace)

FUNCTION checkSession(session, now):
    idleMinutes ← now - session.lastActive   # 14:30 - 14:05 → 25

    IF session.rememberMe:                   # false
        RETURN "valid"

    IF idleMinutes > session.timeoutThreshold:
                                             # 25 > 20
        session.status ← "expired"           # "active" → "expired"
        RETURN "expired - re-login required"

    RETURN "valid"
```

Note: this is the case `old → new` is reserved for — the previous status "active" is readable neither from the line (which shows only the new value) nor from the preceding lines or input. Everywhere else, bare values or `computation → result` chains suffice.

---

## Example 5: Real async codebase function (branching, CONTINUE/BREAK, nested loops)

Shows the method applied to a denser multi-level function — `CONTINUE`/`BREAK` control flow and nested loops (session loop → entry loop → message loop), with non-matching middle iterations omitted.

```
INPUT: query="timeout", maxResults=undefined, since=undefined, until=undefined,
       includeCurrentSession=undefined, currentSessionFile="~/.pi/.../live.jsonl"

FUNCTION searchSessions(options):
    re ← compileQuery("timeout")             # /timeout/i
    max ← validateMaxResults(undefined)      # 50
    sinceMs ← undefined                      # options.since=undefined
    untilMs ← undefined                      # options.until=undefined
    includeToolCalls ← false                 # options.includeToolCalls=undefined

    sessions ← SessionManager.list(cwd)      # sessions.length=3
                                              #   [0] live.jsonl  [1] big-session.jsonl (8MB)  [2] old-session.jsonl
    currentAbs ← resolve(currentSessionFile) # "/home/user/.pi/.../live.jsonl"

    hits ← []
    skippedFiles ← []
    scanned ← 0

    FOR session IN sessions:

        # --- session[0]: live.jsonl ---
        IF resolve(session.path)==currentAbs
           AND includeCurrentSession!==true: # session.path → currentAbs, includeCurrentSession=undefined
            CONTINUE

        # --- session[1]: big-session.jsonl ---
        stat ← fs.statSync(session.path)     # stat.size=8388608
        IF stat.size > MAX_SESSION_FILE_BYTES:
                                             # 8388608 > 5242880
            skippedFiles ← skippedFiles + [entry]
                                             # ["big-session.jsonl (8192 KB)"]
            CONTINUE

        # --- session[2]: old-session.jsonl ---
        stat ← fs.statSync(session.path)     # stat.size=45000
        IF stat.size > MAX_SESSION_FILE_BYTES:
                                             # 45000 > 5242880
            skippedFiles ← skippedFiles + [entry]
            CONTINUE

        { header, entries } ← loadSessionEntries(session.path)
                                              # header.id="sess-old-01", entries.length=12
        scanned ← scanned + 1                # 1
        contextEntries ← buildContextEntries(entries)
                                              # contextEntries.length=9

        # entries[0..2] did not match re — omitted from the trace
        FOR entry IN contextEntries:
            FOR msg IN sessionEntryToContextMessages(entry):
                                              # entry.id="entry-004", entry.timestamp="2026-09-10T08:12:00Z", msg.role="assistant"
                haystack ← haystackFor(msg, includeToolCalls)
                                              # "...connection timeout after 30s while..."
                match ← haystack.match(re)   # match.index=18, match[0]="timeout"

                hits ← hits + [{
                    sessionPath: "old-session.jsonl", sessionId: "sess-old-01",
                    entryId: "entry-004", timestamp: "2026-09-10T08:12:00Z",
                    role: "assistant", snippet: buildSnippet(haystack, 18)
                }]                           # hits.length=1

    hits.sort(...)                           # hits.length=1, order unchanged

    RETURN { hits, truncated, skippedFiles, scanned }
                                              # hits.length=1, truncated=false,
                                              # skippedFiles=["big-session.jsonl (8192 KB)"], scanned=1
```

Omission choices:
- The `IF hits.length >= max` early-exit check (evaluated before each session) is omitted — `hits.length=0` never approached `max=50`, so repeating that check per session is pure noise.
- `entries[0..2]` (no match) collapse into a single line instead of per-entry `match=null → CONTINUE` — iterations with no substantive effect on the state trajectory get folded.
- `session[2]` keeps its size-guard line with the substituted condition `# 45000 > 5242880` — same guard convention as Examples 3 and 4: the line and its body stay, the deciding values show it was not taken.
