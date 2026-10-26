# DeepSeek Harness Architecture

English | [中文](architecture.zh.md)

Read before changing `packages/`. Cordis knowledge is assumed; otherwise start with the [primer](cordis-primer.md) or [tutorial](cordis-tutorial/index.md).

## Cordis

[Cordis](cordis-primer.md) underlies dsh: plugins contribute services, typed events, and reversible effects to a shared context. Every component—including the model adapter, tool registry, session log, and agent loop—is a plugin replaceable through configuration.

No privileged core needs patching: mount plugins beside existing ones; their registrations are effects that unwind on unload.

## Profiles and bundles

`dsh` boots a plugin tree from ordered layers.

A **profile** is a named composition in the Harness home. It lists bundles and holds installed out-of-tree plugins and the user's `cordis.patch.yml`. Shipped templates: `web`, `headless`, `sdk`, `sdk-minimal`, and `acp`.

A **bundle** distributes Cordis config rows and their code; higher layers can patch everything it inserts.

Both use `package.json`'s `dsh` field: `dsh.profile` lists bundles; `dsh.bundle` names the bundle's patch file.

[`dsh-base`](../packages/bundle/base/README.md) is the shared first layer of the `web`, `headless`, `sdk`, and `acp` profiles: model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry. [`dsh-web-app`](../packages/bundle/web-app/README.md) adds the browser application, [`dsh-headless`](../packages/bundle/headless/README.md) adds a one-shot runner with no server, [`dsh-sdk-app`](../packages/bundle/sdk-app/README.md) adds the SDK JSON-RPC server, and [`dsh-acp-app`](../packages/bundle/acp-app/README.md) adds the automation-only ACP server. [`dsh-sdk-minimal`](../packages/bundle/sdk-minimal/README.md) is the deliberate exception: one bundle owns its complete explicit SDK tree and does not apply `dsh-base`.

Layers apply to an empty entry list: ordered profile bundles, its `cordis.patch.yml`, the home patch, then `--patch` overlays. Patches replace a row's whole config by id or insert rows. A `preset` patch operates inside that declaration’s `config.plugins` with the same precedence.

YAML controls HMR: base enables config-only `dsh-hmr`; headless, SDK and ACP disable it; `sdk-minimal` omits it. Profile patches override these defaults. HMR coordinates watching and reloads; the launcher provides profile data and readiness.

Base includes [Plugin Manager](../packages/boot/plugin-manager/README.md) for Web and agents.

Inspect the boot tree:

```sh
dsh --profile web --dump-config
```

Any row it prints can be replaced by a patch of your own.

Composition mechanics are in [app-boot](../packages/boot/app-boot/README.md#profiles); config fields are in the generated [config catalog](config-catalog.md).

## Application launch

Supported Node applications use named `dsh` profiles: `web`, `headless`, `sdk`, `sdk-minimal`, and `acp`, selected by `dsh --profile <name>` or `dsh <name>`. `plugin` is the management command; a same-named profile requires `--profile plugin`. The TypeScript SDK resolves same-version `dsh` and selects `sdk`. Custom composition uses profiles and ordered patches, never another executable or inline application tree. `sdk-minimal` is a repository-owned standalone bundle behind the same launcher, not a caller-supplied Cordis tree.

Vendored CLIs, build/test executables, direct in-process plugin mounting, and private browser WebWorker previews are not Harness application launchers. [`verify-application-entrypoints`](../scripts/verify-application-entrypoints.ts) explicitly classifies package bins, executable sources, root demos, `start:web`, and `dev:web`, rejecting Node applications that bypass `dsh`.

The Python SDK uses the same architecture: its `deepseek-harness-sdk-runtime-<platform>-<arch>` wheel packages the normal CLI; clients default to `dsh --profile sdk` with an explicit Harness home. The minimal example selects `sdk-minimal`. Python exposes profiles and ordered patches, not complete Cordis trees; `dsh plugin` installs persistent external plugins. The removed private direct-config carrier has no compatibility bin or fallback parser.

## Desktop application

The [Electron desktop app](../apps/desktop/README.md) ships its exact dsh production runtime in signed resources and owns reserved `$DSH_HOME/profiles/desktop`. Shared helpers initialize profiles, reconcile bundles, and resolve installation/bundle dependencies without replacing pnpm-owned packages. Desktop and npm CLI share product data, but not packages, activation, or lockfiles. Desktop’s bundled CLI manages its initialized plugins.

Electron starts the private Desktop Host in Electron Node mode. The Host runs the shared CLI profile runner and complete Web app. The window immediately loads packaged Web assets, awaiting boot injections before activating client plugins in the same document. Web owns RPC/streams; the desktop carrier connects the local page to the authenticated Host. Node IPC carries boot injections, readiness, fatal errors, and shutdown. Desktop defaults to an OS-assigned port, overridable by profile configuration. Shell-owned UI runs plugin transactions through bundled pnpm with normal user/profile configuration.

## Core packages

| Package | Owns | `ctx` key |
|---|---|---|
| [`core/session`](subsystems/session.md) | The append-only `SessionEvent` log and in-memory store | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.md) | Prompt-section and tool-schema assembly | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.md) | The scoped tool registry and guarded execution pipeline | `ctx.tools` |
| [`core/agent`](subsystems/core.md) | The `Agent` interface, live registry, and `agent/*` events | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.md) | The default driver implementing that interface | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.md) | The per-agent scoped-registration primitive | library, no key |
| [`llm/llm`](subsystems/llm-streaming.md) | Message and stream vocabulary plus the adapter seam | `ctx.llm` |

The [native creation transaction](subsystems/core.md#creation-and-ownership) awaits unpublished setup, commits it once and persists its remaining Session events before publication. An optional synchronous current check revalidates setup after persistence and publication awaits; failure follows the original rollback and teardown ownership.

## Events

Events are extension points; most changes start with their domain.

- **Session events** are durable facts appended to the log and broadcast through `session/event`. Use one when the fact must survive a reload.
- **Agent events** (`agent/*`) carry a live `Agent`: inbox, step, status, request, validation, continuation. Use one to observe or intercept work in flight.
- **Capability events** attach policy and adapters to a seam (`fs/*`, `tools/*`, `telemetry/*`) without importing the loop.

AgentLoop awaits serial `agent/created` before queued work and rolls back failed initialization. Owners can call `ctx.agentLoop.stop()` to end its work before graph disposal. Teardown retains required resources; [agent-loop](../packages/core/agent-loop/README.md#understand-the-implementation) defines ordering.

The [event map](event-producer-consumer.md) lists every event's producers and consumers.

## Turn flow

A **step** is one model request plus the tools it calls. A **turn** is zero or more steps: it opens before its first input is claimed and closes once nothing is owed.

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step; project runtime context at fallback
                                     reject | enter(messages, startsRequestSeries?)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     agent/request -> prepareCall (cancellation commits neither system nor users)
     reconcile system/message using the prepared call capability
     append entered messages as user/message; reconcile retained runtime context
     log request/header and request/context as needed
     derive and freeze model history from the log
     stream the bound prepared call -> llm/stream -> agent/assistant-stream start
       agent/assistant-stream chunk*
       assistant/message | assistant/attempt -> agent/assistant-stream end
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `system/message`, `user/message`, `assistant/message`, `assistant/attempt`, and `tool/*` are durable session events; the rest are live extension points across three domains. `agent/assistant-stream` publishes process-local start, transient chunk, and end frames. The loop commits the complete compact stream as one message or log-only attempt before a committed end frame, and the Web Session-follow adapter is the live event's only remote consumer. `agent/pre-step`, `agent/request`, `llm/stream`, and the three `tools/*` events are waterfalls, whose listeners must call `next()` to delegate; `agent/turn-stopping` is serial and has no `next()`.

Loop [quiescence](../packages/core/agent-loop/README.md#understand-the-implementation) includes driver, inbox and startup activity.

One inbox feeds the driver; injected context awaits waking input. Durable `inbox` projects pending input without live Agents.

`agent/pre-step` decides the accepted input. Listeners may rewrite or reject claimed messages; a rejected or empty first claim closes a durable turn without a step. An enter decision may set `startsRequestSeries`: the loop logs a fresh `request/header` (reason `series`, or `change` with `startsSeries: true` when the envelope also changed). Wrapping listeners preserve that declaration with `{ ...decision, messages }`. After assembly and `step/start`, `agent/request` and `prepareCall()` resolve the actual route before the system prompt and accepted users are committed; cancellation during either async phase commits neither. Prepared call capabilities govern prompt admission, not preceding `request/context`. Each attempt refreshes registered runtime facts, reconciles the bound prompt, admits users once, and restores removed runtime context, logs header/context as needed, and freezes the request before streaming the bound call. Retries do not repeat assembly or `agent/pre-step`. Surface replacements and image-offload decisions after attachment start a new request series, including during the first resumed pre-step; unchanged resume continues the series. The first admitted step reserves the system head before user messages even for an empty prompt (no wire message). The prompt travels only as `system/message` history: an empty rendering clears all active system nodes, leaving no old prompt model-visible; capable routes append non-empty updates after cached history, including supported tool updates; incapable routes and new request series consolidate non-empty prompt text at the first system node, with logged empty replacements for non-empty later system nodes ([decision](../.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md); [decision rule](../packages/core/agent-loop/README.md#understand-the-implementation)).

The loop sends immutable requests with live cancellation and reuses freeze evidence for frozen identities; [agent-loop](../packages/core/agent-loop/README.md) owns construction and cancellation causes.

Failed steps [record missing tool results](../packages/core/agent-loop/README.md#understand-the-implementation).

Details: the [sequence diagram](agent-lifecycle.md), the [tool pipeline](tool-execution-pipeline.md), and [cancellation and error recovery](subsystems/core.md#the-agent-handle).

## Session log

The session log is the source of the context the model sees. `deriveMessages()` projects model history from it. Each `assistant/message` embeds the exact compact timed stream that produced its assembled content; `assistant/attempt` retains settled failed, retried, cancelled, and stream-error attempts without adding model history. Fork, resume, transcripts, telemetry, and persistence all derive from these durable settlements, while live UI incrementality comes from `agent/assistant-stream`; a hard process loss before settlement leaves no durable attempt stream ([decision](../.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.md)).

Session consumers know only the current logical format. Header-only `stat` and `list` rescan each Session directory, select its numerically highest canonical generation, and translate a supported historical header without loading events or publishing a successor. A stored-session `open` selects that same generation, refuses a future version, or decodes and composes the static adjacent migration chain once before returning validated current logical events. A read open uses that in-memory result without publishing a successor; a write open first encodes, verifies, and exclusively publishes the final version-named successor beside the unchanged source. Ordinary repair of an unsealed interrupted tail remains a handle consumer responsibility; migration inserts a missing interrupted `turn/end` only for the bounded released restart already sealed by a later `turn/start`. JSONL v0 uses `session.jsonl[.zstd]`, v1 and later use lowercase `session.vN.jsonl[.zstd]`, and committed generation paths are never renamed, replaced, or deleted. The JSONL provider owns physical framing, compression, generation selection, and exclusive publication, while each adjacent migration package owns exactly one `vN -> vN+1` step ([decision](../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md)).

**Model-visible means logged.** Every model request must be reconstructable from the log. New model-visible inputs require session events. Plugins changing existing message content register [pure message projections](subsystems/session.md#plugin-owned-message-projections); detached readers supply the same definitions explicitly. Tool changes are capability-independent; [Session tool history](../packages/core/session/README.md) supplies provider declarations.

**Projection seam.** `dsh-session-projection` owns `ctx.sessionProjections`: registered units fold committed events incrementally, host consumers read one typed state with `stateOf()`, and carriers batch cropped client views with `snapshot()`. A host reader either requires this service during activation or fails explicitly when the registry or required key is absent. Contributors may retain `ctx.inject(['sessionProjections'], ...)` registration without silently defaulting a missing host value. The agent loop registers shared `turnBoundary` state for its readers ([decision](../.agents/notes/implemented/architecture/2026-08-19-session-projection-mandatory-seam.md)).

[Working directories](subsystems/working-directory.md) supply user context and execution paths without changing original project identity, sandbox write roots, or existing process directories.

## Capability seams

A **seam** is a swappable capability: a **Service Definition** declares its interface, a **Service Provider** implements it, and a **Consumer** uses it, often a model-facing tool. Packages can combine roles; no single role is a seam. Design all three for new capabilities ([capability graph](capability-seams.md)).

Swapping one provider changes the product. Filesystem and subprocess providers share one execution world: targeting a remote sandbox moves Bash, PTY, and LSP together without provider forks. [Subagent providers](subsystems/subagent.md) span fresh child agents and delegated turns in other products behind one interface.

[Experimental Agent Teams](subsystems/agent-team.md) exposes opt-in `ctx.agentTeams` coordination with durable roster and task state plus direct inbox messaging over continuable subagents.

## Where new behavior goes

Attach behavior to documented extension points; loop changes update this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; its schema joins prompt assembly |
| Give one session a different capability set | compose an agent preset; a service row there needs an `isolate` realm |
| Add shell execution | register a `ctx.shell` backend; the local one spawns through `ctx.subprocess` |
| Add persistent terminal execution | register a `ctx.terminals` backend plus `dsh-tool-terminal` |
| Add a human command | register on `ctx.commands`; it dispatches without a model turn |
| Manage background jobs | register on `ctx.jobs`; `job_*` tools read or stop jobs |
| Start a Session from an external webhook | register a trusted rule on `ctx.webhookRuntime` and mount a provider adapter |
| Add filesystem access or policy | register a `ctx.fs` provider or listen to `fs/*` events |
| Confine spawned processes | use a `ctx.sandbox` backend; consumers wrap argv before spawning |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/turn-stopping` stops a turn |
| Add model-facing context | call `agent.inject()`; it lands in the next admitted request |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add a Web Client Chat node | register a `ConversationNodeDefinition` + keyed renderer |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |
| Generate session titles | register the sole `ctx.sessionTitle` provider |
| Manage a same-session objective | use `ctx.goals`; continue through `agent/*` |
| Fork a session at a turn boundary | `ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })` — only agent-loop-published sessions persist |
| Store sessions in a new backend | implement `SessionPersistence` (`create`/`open`/`stat`/`list`/`export`) over the shared handle scaffolding |
| Scope a registration to one agent | use that agent's `agent.ctx` |

The [extension cookbook](cookbook/extension-cookbook.md) maps features to capabilities and indexes the step-by-step guides for [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [settings pages](cookbook/adding-a-settings-card.md). The [Conversation subsystem](subsystems/conversation.md) owns Chat-node assembly.
