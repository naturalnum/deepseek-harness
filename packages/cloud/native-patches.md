# Native integration maintenance

English | [中文](native-patches.zh.md)

This reference separates the seven Cloud packages from the native code they consume. It adds no runtime component. The comparison base is `master`, the local native baseline used for this fork's audit; it is not a claim that this is the latest upstream release. Choose the intended upstream revision separately before upgrading.

## Ownership

Cloud packages own account identity, owner routing, tenant policy, storage admission, execution binding and browser revocation. Native DSH owns Agent/Session state, dispatch, configuration application, filesystem primitives, Shell consumers and generic UI. A native callback performs its check at the actual commit or release point; an HTTP precheck cannot replace that check after an await.

| Native surface | Cloud consumer and retained native responsibility |
|---|---|
| [Session Controller](../api/session-controller/src/index.ts), [commands](../api/session-controller/src/commands.ts) | [pe-cloud-api/native](pe-cloud-api/src/native.ts) supplies project, directory, prompt-file and model admission. Native creation, receipt binding and model selection remain native. |
| [AgentLoop](../core/agent-loop/src/index.ts), [Subagent](../subagent/subagent/src/index.ts) | [pe-cloud-runtime integration](pe-cloud-runtime/src/account-native-integration.ts) supplies actual graph/parent/project admission. Native Agents, turn execution and child disposal are reused. |
| [Settings Controller](../api/settings-controller/src/index.ts), [Credentials](../credentials/credentials/src/index.ts) | [Native first screen](pe-cloud-api/src/native-first-screen.ts), [save hook](pe-cloud-api/src/native-save-hook.ts) and model-key policy retain authorization through the original write, including its actual failure. |
| [Config impact](../boot/app-boot/src/config-impact.ts), [ConfigEditor](../boot/config-editor/src/index.ts), [PluginManager](../boot/plugin-manager/src/index.ts) | [Plugin control](pe-cloud-api/src/plugin-control.ts) supplies policy. Native composition, prepared impact, persistence and Loader application stay native; plans privately own their preparation. |
| [Loader entries](../../vendor/loader/src/config/entry.ts), [Loader](../../vendor/loader/src/index.ts), [groups](../../vendor/loader/src/config/group.ts) | Native editors and Cloud saves share exact mutation guards, per-entry versions and actual child-update settlement. Default unguarded behavior remains native. Vendor changes are logged in [vendor/README](../../vendor/README.md). |
| [Gateway](../api/gateway/src/index.ts), [Connection](../client/connection/src/rpc-host.ts) | [pe-cloud-access Peers](pe-cloud-access/src/peers.ts) bind authentication and forwarding. Native mux, iterator/Peer completion and optional complete-frame budgets are shared; do not copy the streaming engine. |
| [Workspace metadata](../workspace/workspace/src/metadata.ts), [Attachment store](../attachment/attachment-local/src/file-store.ts) | [pe-cloud-files](pe-cloud-files/README.md) and [account attachments](pe-cloud-runtime/src/account-attachments.ts) provide actual project/storage authority. Native storage and close/publication outcomes remain authoritative. |
| [Shell](../shell/shell/src/index.ts), [Fs](../fs/fs/src/index.ts), [Subprocess](../subprocess/subprocess/src/index.ts) | [pe-opensandbox providers](pe-opensandbox/src/native-providers.ts) adapt original Shell/Fs/Subprocess consumers to the same Session environment and owns execution slots. Paths alone do not authorize access; unknown release cannot free a slot. |
| [Instruction injection](pe-account-instructions/src/session.ts) | pe-account-instructions reserves bounded files-owned reads and supplies native turn snapshots. It does not create another prompt or Session history. |
| [Client persistence](../client/store/src/index.ts), [Web entry](../client/web/src/boot.ts) | [pe-cloud-client lifetime](pe-cloud-client/src/client/page-lifetime.ts) supplies the account/generation-bound port before activation and revokes it before cleanup. Native UI and module lifecycle are reused. |
| [Web bootstrap](../../apps/web/src/cloud-web.ts) | This pre-module entry is owned by pe-cloud-client integration but remains an explicit application patch. Moving it into the dynamic client entry would require another static/dynamic build route; keep the current bootstrap until an equivalent native pre-boot integration exists. |
| [Frontend](pe-cloud-access/src/frontend.ts), [field policy](pe-cloud-api/src/ordinary-config-policy.ts) | Cloud public-page routing and ordinary editable-field policy live in existing Cloud packages. The native frontend and ConfigField implementations are restored. Models uses native onboarding; protected Cloud keys use the separate manual integration. |

Generic fixes remain native patches: UTF-8 and complete-frame bounds, cancellation and close results, CSV byte-range preview, completed-answer file links, upload receipts, configuration redaction, width geometry and activation judgment. Moving their engines into Cloud would duplicate native functionality. Keep their owning tests and evaluate them as separate upstream contributions.

## Upgrade procedure

1. Record the current clean source revision, deployment revision, chosen upstream revision and trusted configuration before changing anything. Source tests and an old running release are different evidence.
2. Inspect `git diff --stat <base> HEAD` and the ownership table. Keep Cloud policy in its package. Remove a native patch only when an equivalent public native capability preserves its actual callers, default behavior, authorization, cancellation and settlement.
3. Export outside the worktree with `git diff --binary --full-index <base> HEAD > /absolute/output/cloud-native.patch`. An optional split into Cloud, native API, native client, native runtime and support patches must cover every changed path once. On the exact base, replay in an isolated Git index and compare the resulting tree with `HEAD^{tree}`; this proves reconstruction, not compatibility with a newer upstream.
4. Review conflicts in an isolated checkout of the chosen upstream. Do not force an old patch over a changed commit point, weaken a guard, duplicate a native engine or enlarge tenant quotas to resolve a conflict.
5. Build the changed artifacts and run their native default and Cloud composition regressions. Configuration work includes `packages/boot/config-editor/tests` and the Cloud approved-control tests; browser changes also need the owning GUI/browser cases. Inspect skipped tests and retain failed results.
6. Stage a versioned product, preserve the previous release, then normally stop and join the original application and verify owner/allocation release before starting its successor. Check real login, model/Shell execution, history, file preview/download and logout. Do not declare closed optional capabilities accepted or turn quarantined state into readiness.

Native patch removal is conditional on equivalent behavior, not on reducing a file count. Optional plugin management, preview, arbitrary SSH, host failover and large-file acceptance require their own runtime evidence; passing this maintenance workflow does not enable them.
