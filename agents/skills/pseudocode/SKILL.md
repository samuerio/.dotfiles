---
name: pseudocode
description: "Generate detailed pseudocode for the main components defined in an architecture document (produced by the `architecture` SKILL)."
---

# Pseudocode

Use this skill to translate the main components from an architecture document (either `research.md` or `design.md` produced by the `architecture` SKILL) into clear, language-agnostic pseudocode.

## Core Behavior

When using this skill, first identify the source of the architecture document to determine the generation mode:

### Scenario A: Research Mode (Input: `research.md`)
- **Goal:** Reverse-engineer the existing system.
- **Action:** Translate the actual implementation logic of the components into pseudocode.
- **Handling Ambiguity:** If the architecture document lacks detail on a component's internal logic, infer it from the provided codebase context. If still unclear, use placeholders (e.g., `// TODO: implementation details unclear`) or state assumptions in the `ASSUMPTIONS` section. **Do not ask the user for clarification**, as the system already exists.

### Scenario B: Draft Mode (Input: `design.md`)
- **Goal:** Forward-design the new system.
- **Action:** Flesh out the conceptual design into concrete, executable pseudocode.
- **Handling Ambiguity:** If the design spec is ambiguous about a component's internal behavior, edge cases, or specific implementation details, **do not ask the user for clarification**. Instead, infer a reasonable implementation based on the overall design intent, and state your assumptions in the `ASSUMPTIONS` section. If the ambiguity completely prevents logical implementation, use placeholders (e.g., `// TODO: define specific edge case handling`).

### Common Steps (For Both Modes)
1. Read the provided architecture document.
2. **(Scenario A only)** Read the relevant source code files from the codebase to gather implementation details and context for the components described in the architecture document.
3. Extract the list of main components from the "Component Responsibilities" section.
4. For each component, generate detailed pseudocode representing its core logic, internal state, data structures, and interactions. Add separate sections for DATA STRUCTURES or INTERACTIONS only if they are complex or central to the component's role.
5. Break complex logic into named subroutines to maintain readability.
6. Follow the pseudocode style and formatting rules defined below.
7. Include error handling and edge cases. Add complexity analysis if the component contains non-trivial algorithms.
8. **Do not write production code (e.g., Python, Java, TS) unless the user explicitly asks for implementation.**

## Document Structure

The generated `pseudocode.md` must follow this overall structure:

1. **Component Overview**: Start with `## Component Overview`. Use a `text` code block to list all extracted components and their core responsibilities in a concise, hierarchical format.
2. **Components**: Detailed pseudocode grouped into sections.
   - **Ordering**: Primary ordering follows the **Primary Flow** (Section 2 of the architecture document). Sections appear in the order their components participate in the primary runtime flow. Components not on the primary flow (cross-cutting / infrastructure) are grouped at the end. If the Primary Flow is non-linear or unclear, fall back to dependency order (foundational/low-level first).
   - **Grouping is flexible, not one-component-per-section**: A section may cover a single component, or it may combine several closely related components into one section when they share a common theme, run at the same point in the flow, or are natural variants of each other (e.g. sibling execution modes, a resource plus its lifecycle helpers, a mechanism plus its supporting utilities). Judge this the way a human architect would name chapters in a design doc — group by narrative/conceptual unit, not by rigidly mirroring the "Component Responsibilities" table row-for-row. Each grouped component still gets its own `PSEUDOCODE:` block within the section; only the heading and prose framing are shared.
   - **Headings**: Use `## [Index]. [Section Title]`, where `[Section Title]` is a short descriptive label — either a single component name (`SubagentTool: Tool Entry Point`) or a combined label for grouped components (`Single / Parallel / Chain 三种执行模式`, `AgentDiscovery：发现命名 agent`). Prefer natural, readable phrasing over a mechanical "ComponentName: Description" template when multiple components share the section.
   - **Separators**: Use `---` to separate each section for better readability.
3. **Main Call Graph**: End the document with `## Main Call Graph`. Use a `text` code block with ASCII arrows to illustrate the high-level invocation sequence and data flow among the main components.

## Output Path

Save the generated pseudocode document in the **same directory** as the input architecture document, named `pseudocode.md`.

After writing the file, use this exact phrasing:

> Pseudocode saved — run `code [output-path] &` to review.

## Required Sections per Component

The sections below apply **per component's pseudocode block**, regardless of whether that component has its own heading or shares a heading with sibling components in a grouped section (see Document Structure above).

### [Component Name]

A brief description of the component's role based on the architecture document.

```text
PSEUDOCODE: component name
PURPOSE: brief explanation
INPUT: inputName (type), ...
OUTPUT: result or side effect

ASSUMPTIONS:
    - assumption 1

MAIN FLOW:
BEGIN
    step-by-step logic
END

ERROR HANDLING:
    - case → behavior

EDGE CASES:
    - case → behavior
```

**Optional Additions (Include only if highly relevant to the component):**
- **INTERACTIONS**: Add if the component's primary role involves communicating with other components (e.g., API calls, message queues). If interactions are trivial, describe them inline within `MAIN FLOW`.
- **DATA STRUCTURES**: Add before `MAIN FLOW` if the component relies on complex, non-obvious data structures (e.g., specific trees, graphs, custom caches).
- **HELPER ROUTINE**: Add if the component relies on distinct, reusable subroutines. Format as `HELPER ROUTINE: RoutineName` followed by `BEGIN ... END`. You can include multiple helper routines within the same component block.
- **COMPLEXITY**: Add at the end if the component contains non-trivial algorithms (Time/Space complexity).

**For specific component types, add specialized sections when useful:**
- **State machines / Lifecycle:** `STATES`, `EVENTS`, `TRANSITIONS`
- **API / Gateway components:** `REQUEST`, `RESPONSE`, `VALIDATION`, `SIDE EFFECTS`
- **Workflow / Orchestration components:** `ACTORS`, `TRIGGERS`, `STEPS`, `APPROVALS`
- **Validation / Rule components:** `FIELDS`, `RULES`, `EXCEPTIONS`, `PRIORITY ORDER`

## Language & Formatting

- **Prose & Comments**: All natural language descriptions, explanations, and comments (e.g., text under `PURPOSE`, `ASSUMPTIONS`, `ERROR HANDLING`) must strictly **match the language of the input architecture document** (`research.md` or `design.md`).
- **Identifiers**: Component names, variable names, function names, and data structures must remain in **English** (camelCase or PascalCase).
- **Keywords**: Pseudocode control flow keywords (e.g., `IF`, `ELSE`, `BEGIN`, `END`, `RETURN`, `CALL`) must be in **UPPERCASE ENGLISH**.

## Pseudocode Style

Use:

```text
IF / ELSE / END IF
FOR EACH / END FOR
WHILE / END WHILE
RETURN
CALL FunctionName(...)
value ← expression
```

Avoid:

- Language-specific syntax such as Python, JavaScript, Java, or SQL unless the user explicitly asks.
- Overly abstract descriptions that cannot be implemented.
- Hidden assumptions without naming them.

## Logic Design Guidance

When useful, apply common logic, workflow, validation, state, data structure, or algorithmic patterns such as:

- Decision table for business rules with priority order
- State machine for lifecycle or status transitions
- Validation pipeline for field‑level and cross‑field checks
- Hash map lookup for fast membership or grouping
- Queue or priority queue for scheduling, BFS, or ordering
- Stack for parsing, backtracking, or DFS
- Set for deduplication
- Trie for prefix search
- Sliding window for contiguous sequence problems
- Binary search for monotonic decision problems
- Dynamic programming for overlapping subproblems
- Graph traversal for dependency or relationship problems
- Token bucket or leaky bucket for rate limiting
- Strategy pattern when behavior must be interchangeable

Explain why a chosen structure or pattern fits the specification.

When a specific pattern or structure is central to the solution, include a compact pattern block before or after the main pseudocode.

Example data structure block:

```text
DATA STRUCTURE: UserCache
Type: LRU cache with TTL
Size: 10,000 entries
TTL: 5 minutes
Purpose: Reduce repeated user lookups

Operations:
    get(userId):        O(1)
    set(userId, data):  O(1)
    evict():            O(1)
```

Example algorithm pattern block:

```text
PATTERN: Rate Limiting — Token Bucket

CONSTANTS:
    BUCKET_SIZE = 100
    REFILL_RATE = 10 tokens per second

PSEUDOCODE: CheckRateLimit
INPUT: userId (string), action (string)
OUTPUT: allowed (boolean)

BEGIN
    bucketKey ← userId + ":" + action
    bucket ← Buckets.get(bucketKey)

    IF bucket is null THEN
        bucket ← {tokens: BUCKET_SIZE, lastRefill: Now()}
        Buckets.set(bucketKey, bucket)
    END IF

    elapsed ← Now() - bucket.lastRefill
    bucket.tokens ← MIN(bucket.tokens + elapsed * REFILL_RATE, BUCKET_SIZE)
    bucket.lastRefill ← Now()

    IF bucket.tokens >= 1 THEN
        bucket.tokens ← bucket.tokens - 1
        RETURN true
    END IF

    RETURN false
END

COMPLEXITY:
    Time:  O(1)
    Space: O(n), where n is the number of active user/action buckets
```

Example design pattern block:

```text
PATTERN: Strategy — Authentication

INTERFACE: AuthStrategy
    authenticate(credentials) → User or Error

STRATEGY: EmailPasswordAuth
    authenticate(credentials):
        validate email and password
        verify password hash
        return user or error

STRATEGY: OAuthAuth
    authenticate(credentials):
        exchange OAuth token
        validate provider response
        return user or error

CONTEXT: AuthContext
    selectedStrategy: AuthStrategy

    execute(credentials):
        RETURN selectedStrategy.authenticate(credentials)
```

## Example Output

> *Note: The example below assumes the input architecture document is in English.*

````markdown
## Component Overview

```text
COMPONENTS:
    SubagentTool
        - Receives task / tasks / chain / resume / listModels parameters
        - Validates execution mode and dispatches to the corresponding flow

    AgentDiscovery
        - Loads *.md agents from user and project directories
        - Parses frontmatter to extract configurations

    ModelPolicy
        - Loads models-allowlist.json
        - Validates if the model is allowed
```

---

## 1. SubagentTool: Tool Entry Point

`index.ts` registers a tool named `subagent`, supporting single, parallel, and chain modes, along with parameters like `resume` and `timeoutMs`. The source code enforces that "only one execution mode can be selected".

```text
PSEUDOCODE: ExecuteSubagentTool
PURPOSE: Handle the main agent's call to the subagent tool and dispatch to the corresponding execution mode
INPUT:
    params (SubagentParams)
    signal (AbortSignal)
OUTPUT:
    toolResult (AgentToolResult)

ASSUMPTIONS:
    - params can only contain one of task, tasks, or chain modes
    - listModels is a query mode and will not spawn a child process

MAIN FLOW:
BEGIN
    agentScope ← params.agentScope OR "user"
    discovery ← CALL DiscoverAgents(ctx.cwd, agentScope)
    agents ← discovery.agents

    modelPolicyResult ← CALL LoadModelPolicy()

    IF params.listModels IS true THEN
        RETURN BuildModelListResponse(modelPolicyResult.policy)
    END IF

    hasSingle ← params.task exists
    hasParallel ← params.tasks is not empty
    hasChain ← params.chain is not empty

    modeCount ← CountTrue(hasSingle, hasParallel, hasChain)

    IF modeCount != 1 THEN
        RETURN ErrorResult("Provide exactly one mode")
    END IF

    IF hasChain THEN
        RETURN CALL RunChainMode(params.chain, agents, ...)
    END IF
    
    IF hasParallel THEN
        RETURN CALL RunParallelMode(params.tasks, agents, ...)
    END IF
END

ERROR HANDLING:
    - Multiple modes present or all empty → return parameter error
    - Project-level agent not confirmed → cancel execution
```

---

## 2. AgentDiscovery: Discover Named Agents

The project supports optional named agent files: user-level directory `~/.pi/agent/agents/*.md` and project-level `.pi/agents/*.md`. The source code parses markdown frontmatter.

```text
PSEUDOCODE: DiscoverAgents
PURPOSE: Discover available named agents based on agentScope
INPUT:
    cwd (string)
    scope ("user" | "project" | "both")
OUTPUT:
    discoveryResult

DATA STRUCTURES:
    AgentConfig:
        name, description, tools, model, systemPrompt, source

MAIN FLOW:
BEGIN
    userDir ← AgentHomeDir + "/agents"
    projectAgentsDir ← CALL FindNearestProjectAgentsDir(cwd)

    userAgents ← empty list
    projectAgents ← empty list

    IF scope != "project" THEN
        userAgents ← CALL LoadAgentsFromDir(userDir, "user")
    END IF

    IF scope != "user" AND projectAgentsDir exists THEN
        projectAgents ← CALL LoadAgentsFromDir(projectAgentsDir, "project")
    END IF

    // Project-level agents can override user-level agents with the same name
    agentMap ← empty map keyed by agent.name
    ADD all userAgents to agentMap
    ADD all projectAgents to agentMap

    RETURN {
        agents: Values(agentMap),
        projectAgentsDir: projectAgentsDir
    }
END

HELPER ROUTINE: LoadAgentsFromDir
BEGIN
    IF dir does not exist THEN
        RETURN empty list
    END IF

    entries ← ReadDirectory(dir)
    agents ← empty list

    FOR EACH entry IN entries
        IF entry is not "*.md" THEN
            CONTINUE
        END IF

        content ← ReadFile(entry)
        frontmatter, body ← ParseFrontmatter(content)

        IF frontmatter.name missing THEN
            CONTINUE
        END IF

        ADD AgentConfig {
            name: frontmatter.name,
            description: frontmatter.description,
            systemPrompt: body
        } to agents
    END FOR

    RETURN agents
END

COMPLEXITY:
    Time:  O(n), where n is number of markdown files scanned
    Space: O(n)
```

---

## Main Call Graph

```text
MAIN CALL GRAPH:

User / Main Agent
    ↓
SubagentTool.execute(params)
    ↓
DiscoverAgents(cwd, agentScope)
    ↓
LoadModelPolicy()
    ↓
Validate exactly one mode:
    - task
    - tasks
    - chain
    ↓
ResolveRunPlan(...)
    ↓
RunSingleAgent(...)
    ↓
Spawn: pi --mode json -p ...
    ↓
BuildEnvelope(result)
    ↓
Return ToolResult
```
````
