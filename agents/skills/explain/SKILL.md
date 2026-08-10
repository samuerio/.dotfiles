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

Explain by horizontal comparison — pick 2–4 peers that solve the same underlying problem, contrast how each approaches it, and extract the transferable model underneath so the knowledge carries across systems.

Examples:

Go Mutex: Go Mutex vs Java synchronized vs Rust Mutex vs C++ mutex
  → model: memory model, atomicity, visibility, scheduling, lock contention.
Go sync.Map: sync.Map vs Java ConcurrentHashMap vs Rust DashMap
  → model: concurrent map tradeoffs among fine-grained locks, atomics, and read-mostly strategies.
