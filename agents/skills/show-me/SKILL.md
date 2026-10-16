---
name: show-me
description: Help the user understand the current topic visually with concise diagrams, code-shape sketches, and focused HTML artifacts.
disable-model-invocation: true
---

Help the user understand the current topic of conversation visually. Skip the preamble and keep prose brief. Pick the smallest view that makes the key point clear.

- Show logic or an algorithm as pseudocode:

```text
on(save)
  if content is unchanged
    return cached result
  write new content
  return fresh result
```

- Show runtime control flow as a call tree:

```text
renderer requests a live chat
└── PiService.createAgentSession(options)
      ├── WorkspaceService.getLayout()
      ├── options.sessionId absent
      │     └── SessionManager.create()
      ├── options.sessionId set
      │     ├── SessionManager.list()
      │     └── SessionManager.open()
      └── createAgentSession({ services, sessionManager })
          └── live AgentSession returned to caller
```

- Show UI structure as a component tree, including state and module boundaries that matter.
  Write sibling nodes as `<A> + <B>`. Only layers that own state, hotkeys, or callbacks
  carry a block; pure render nodes stay bare.

```text
apps/riptide-ui/storybook
├── <SessionsPageWrapper>                   [Storybook full demo]
│     State: activeTab, mockSessions, mockDrafts, mockArchived
│     Hotkeys: useSessionsPageHotkeys (tab switching, cmd+n create)
│     Callbacks: handleCreateSession (mock), handleTabChange
│   └── <SessionsPage>                      [packages/ui - pure page component]
│         Props: sessions, drafts, archivedSessions, activeTab, onTabChange,
│               onCreateSession, focusedSessionId, selectedSessionIds,
│               ...table callbacks
│         ├── <Tabs> + <TabsList> + <TabsTrigger>
│         ├── <CreateSessionButton onClick={onCreateSession}>
│         └── <SessionTableWrapper>         [Storybook table demo]
│               State: focusedSessionId, selectedSessionIds
│               Hotkeys: useSessionTableHotkeys
│                 - j/k: navigation
│                 - shift+j/k: range selection
│                 - x: toggle selection
│                 - meta+a: select/deselect all
│                 - enter: activate session
│                 - shift+r: start rename
│                 - e: archive/discard
│                 - alt+y: bypass permissions
│               Callbacks: handleArchive, handleBulkArchive, handleDiscard,
│                         handleBulkDiscard, handleActivateSession,
│                         handleBypassPermissions
│               └── <SessionTable>          [packages/ui - pure table]
│                     Props: sessions, focusedSessionId, selectedSessionIds,
│                           searchText, matchedSessions, isArchivedView,
│                           isDraftsView, onRowClick, onToggleSelection,
│                           onActivateSession, onSaveTitle, onArchive,
│                           onDiscard, onBypassPermissions, onStartEdit
│                     Internal state: editingSessionId, editValue
│                     ├── <TableHeader>
│                     └── <TableBody>
│                           └── <SessionTableRow>  [packages/ui - pure row]
```

- Show file responsibility or a broad refactor as a shallow file tree:

```text
src/
├── commands/       # parses user actions
├── sessions/       # owns session state
└── transport/      # sends API requests
```

- Show component interaction, control flow, or data flow with Mermaid:

```mermaid
sequenceDiagram
    participant User
    participant UI
    participant Daemon
    User->>UI: choose command
    UI->>Daemon: send expanded prompt
    Daemon-->>UI: stream result
```

- Use `diff` when the point is what changes and the surrounding shape already exists. Match the diff shape to the topic.

For a component change:

```diff
 <SessionsPage>
   ├── <Tabs> + <TabsList> + <TabsTrigger>
+  ├── <StorageWarning />      [packages/ui]
   └── <SessionTableWrapper>
         └── <SessionTable>
             ├── <TableHeader>
+            │     └── <SessionTableHeaderCell name="lastActive" />
             └── <TableBody>
```

For a file-layout change:

```diff
 src/
 ├── commands/
+│   └── show-me.ts       # expands the slash command
 ├── sessions/
-└── transport.ts
+└── transport/
+    ├── client.ts
+    └── stream.ts
```

For a call-tree or call-stack change:

```diff
 renderer requests a live chat
 └── PiService.createAgentSession(options)
       ├── WorkspaceService.getLayout()
-      ├── AuthStorage.create()
-      ├── new ModelRegistry()
-      ├── createCodingTools()
+      ├── PiService.getServices()
+      │     ├── AuthStorage.create()
+      │     ├── new ModelRegistry()
+      │     ├── SettingsManager.create()
+      │     ├── new DefaultResourceLoader()
+      │     ├── DefaultResourceLoader.reload()
+      │     └── createCodingTools()
       ├── options.sessionId absent
       │     └── SessionManager.create()
       └── createAgentSession({ services, sessionManager })
```

For a state or control-flow change:

```diff
 on(save)
-  write content
+  if content is unchanged
+    return cached result
+  write new content
+  invalidate cache
```

- Show the whole block when most of it is new, when omitted context would hide ownership or order, or when the user needs a copyable target shape:

```ts
function expandSkill(command: string): string {
  const skillName = command.slice(1)
  return `use the ${skillName} skill`
}
```

- For a visual UI, layout, state comparison, or concept too dense for Mermaid, write one focused HTML file — a diagram, an infographic, or a short slide deck, whichever fits the point. Match the product's colors, type, spacing, and components; use real labels and data; support desktop and mobile. Then open it for the user:

```
Bash(open path/to/show-me-{description}.html)
```

### guidance

Place each visual next to the short text it supports. Keep only the calls, files, props, states, and boundaries needed to answer the user's current question or the options to resolve the current discussion point.

You may use one of these, you may use several, it is unlikely you will use all of them. Use your judgement and don't overwhelm the user.
