---
description: Rewrite image-containing problems into text-only format for pure reasoning models
agent: general
---
Rewrite the following problem with reference images into a pure text version that text-only reasoning models can fully understand without seeing the images:

1. First extract the core requirement from the original problem
2. For each image: describe ALL visible content in detail, including text, diagrams, UI interfaces, code snippets, error messages, visual elements, etc.
3. Ask me clarifying questions if any content in the images or problem is ambiguous or unclear
4. Combine the original problem and all image descriptions into a complete text-only problem
5. Ensure no visual information is omitted, descriptions are accurate and clear

<original_problem>
$ARGUMENTS
</original_problem>

Output only the rewritten text-only problem directly, no extra explanations.

