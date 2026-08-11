---
name: explain
description: "8 independent subcommands for explaining a target from different angles. Triggers: /explain-what, /explain-13y, /explain-ascii, /explain-hist, /explain-impl, /explain-shape, /explain-learn, /explain-cmp. Each command is independent; do not combine them."
---

# Explain Commands

This skill contains 8 independent subcommands, each corresponding to a different explanation angle. The user triggers only one command at a time; the commands are not meant to be combined.

## Common rules (apply to all 8 commands below)

**Target parsing**
- Infer the target from the command input and/or conversation context. If unclear, ask the user one concise clarifying question.

**Output rules**
- Respond in Chinese.


---

## /explain-what

Explain what it is and what problem it solves.

## /explain-13y

Explain this in a way a 13-year-old can understand.

## /explain-ascii

Explain this using ASCII art diagrams.

## /explain-hist

Explain the development history as a motivation chain — walk through each generation along its evolution path and describe what problem each step was created to solve.

## /explain-impl

Explain how it is implemented.

## /explain-shape

Explain the input/output shape.

## /explain-learn

Explain the learning path — lay out the steps for learning this target from the underlying principles up to the high-level abstraction.

Examples:

Git: hand-written commands -> object model (commit/tree/blob) -> branch mechanics -> GUI.
Database: SQL -> indexes -> execution plans -> ORM.

## /explain-cmp

Explain by horizontal comparison.

1. Pick 2–4 representative peers. Prefer peers that expose different design choices rather than several nearly identical alternatives.
2. Establish a small set of shared comparison dimensions first, such as core abstraction, consistency, persistence, concurrency model, latency/throughput, scaling, and typical use cases. Choose only dimensions relevant to the target.
3. For each peer, open with its **design philosophy**: a one-line summary followed by 3–5 concrete supporting characteristics (e.g. "extreme minimalism = extreme speed" → multi-threaded, slab allocation, no replication, single data type). This is a summary framing, not the full comparison — then compare the peer against the target from the perspective of **design choice → consequence → suitable workload**. Do not merely enumerate features.
4. Frame each pairwise comparison as the question a reader would actually ask (e.g. "both do X, so where's the real difference?"), not a flat "A vs B" label.
5. For important differences, give a concrete code snippet, command, or operation — not just a described scenario — that makes the distinction tangible.
6. Where a wrong choice is common, add a short misuse/anti-pattern example: show the incorrect usage and the corrected one side by side.
7. State the central tradeoff explicitly: what capability or guarantee is gained, and what cost or constraint is accepted in exchange.
8. End with 2–5 transferable rules that generalize beyond the named products. Phrase them as decision principles the reader can reuse in another system, and illustrate at least the non-obvious ones with a short code/pseudocode block.

Keep the target as the center of the comparison. The goal is to explain **why these systems differ and when those differences matter**, not to rank them globally.

When a claim depends strongly on version, configuration, workload, or deployment topology, qualify it instead of presenting a benchmark number or implementation detail as universal.

Suggested output shape:

- comparison dimensions / compact table
- target vs each peer, one subsection per pair, framed as a question
- overall tradeoff map or decision axes (an ASCII diagram works well when the axes are spatial, e.g. latency vs durability)
- misuse/anti-pattern example, if a common wrong choice exists
- transferable rules, code-illustrated where non-obvious

Examples:

Go Mutex: Go Mutex vs Java synchronized vs Rust Mutex vs C++ mutex
  → tradeoff: richer safety semantics (ownership / poisoning / monitors) vs minimal overhead
  → rule: same memory-model problem; pick the primitive by safety guarantees you need, not by language habit.
Redis: Redis vs MySQL vs Memcached vs etcd
  → tradeoff: speed vs durability vs simplicity vs strong consensus
  → rule: place the workload on the speed / consistency / durability axes first, then pick the system at that coordinate.
