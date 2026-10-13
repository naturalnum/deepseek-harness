---
description: "Manage personal Skills, Remote MCP and Cloud STDIO through native pages with direct credential uploads and original-request recovery."
kind: package-reference
---
# PowerEvolve Extension Center

English | [中文](README.zh.md)

## Summary

Users can browse, install and try personal or built-in Skills from the native Skills page. They can manage personal Remote MCP and Cloud STDIO in the official Plugins bundle configuration. Credential and package bytes upload directly to trusted Platform endpoints. External checks and actions retain request identities and approval requirements; browser configuration alone grants no execution permission.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The existing native Skills page provides My skills and All skills with category search. The current cloud profile exposes built-in PDF; the retained release catalog contains nine pinned packages. The page lists, reads, installs, enables, disables and revokes personal text skills and ZIP packages. Upload tickets send package bytes directly to Platform; Host receives no ZIP body. “Try skill” opens an editable native invocation draft in a new Conversation. Personal Remote MCP and generic Cloud STDIO controls render in the official Plugins page’s `@power-evolve/host` bundle configuration. Their slot is `plugins.bundle.config`; shared plugin inventory, navigation and deployment permissions remain native.

The [cloud Web shell](../cloud-web/README.md) includes this browser plugin through native client metadata. It has no separate Profile layer or user-supplied mount fields; the configured [Host bundle](../host/README.md) owns the server-side composition.

<a id="skills-and-package-import"></a>
### Skills and package import

Unmounting installation or import dialogs, or replacing their account client, prevents late replies from updating the view. Cancelling an import retains its original request ID and reports an uncertain result for explicit recovery; a late reply is not confirmed success.

Built-in catalog entries identify a pinned version and digest. Personal installed versions remain their own records; displaying the current catalog does not replace an older installation.

<a id="personal-ssh"></a>
### Personal SSH

SSH browser management is deferred. The current native entry does not construct its HTTP client, load its list or render its section. The retained [deferred composition](src/client/DeferredConnectorConfiguration.tsx) and SSH leaf components preserve the following behavior for historical tests.

The personal SSH page preserves the original password/private-key form, optional passphrase and remote working directory, search, enablement, edit and confirmed deletion. Working directories may be absolute or home-relative, including `~/project`; blank means no directory override. Password and private-key fields open blank when editing and retain the saved secret unless a replacement is entered. Passphrase retention is also explicit in the request; clearing it requires the clear checkbox. Changing authentication kind requires a new credential. Public records contain authentication kind and configured flags, with no secret values.

Creation and any update that replaces a secret reserve a pending ticket through `sshConnectionsTicket`, then upload UTF-8 JSON `{formatVersion:2,password?,privateKey?,passphrase?}` directly to the trusted Platform's fixed `/ssh/upload` path. Only replacement fields are included. Passwords, private keys and passphrases have respective 4096, 7168 and 1024 byte limits; the complete envelope is limited to 65536 bytes. Host receives metadata, replacement instructions and the byte count. Metadata-only updates and explicit passphrase clearing use `sshConnectionsUpdate` without uploading a value. List, toggle and delete use the fixed management RPC; deletion returns a tombstone and the page retains recent checks.

A lost upload response is reconciled through the original request's `sshConnectionsReceipt`; a null receipt remains uncertain. Explicit retries retain the request ID, saved base revision and immutable input; a ticket retry always uploads the bytes again, including after completion.

SSH checks use only saved connection revisions and authenticate without running a remote command. A recent-check list restores owner-scoped call states after refresh and polls nonterminal calls through one bounded list RPC.

An Agent can propose one exact command for a pinned SSH connection; the trusted Platform shows the command and target for separate user approval. Only an approved command runs through the dedicated Runner, with a bounded result continuing the original Session; rejection creates no Runner call, and an execution request can be cancelled.

<a id="personal-remote-mcp"></a>
### Personal Remote MCP

The Remote MCP configuration section contains the original multi-connection forms with search, details, create/edit modal, enablement, deletion, write-only Bearer and custom-header fields, and saved/draft checks with cancellation and durable status. The browser adapter sends metadata through the same-origin MCP management RPC and sends replacement credentials directly to the trusted Platform's fixed upload endpoint using a short-lived ticket. The Host receives names, actions, and byte counts; it never receives credential values. Request IDs and new header rows work on plain HTTP without `crypto.randomUUID`. Lost upload responses are reconciled through the original request receipt. Explicit retries keep the same request ID and immutable input.

Checks use an existing native Session, defaulting to the Session retained by the main view. The selected Session stays fixed while a check is pending; deleting it invalidates that draft, and late responses cannot replace a changed draft or canceled check. Connection identity, configuration and credential revisions identify stale saved checks. An older result remains visible as history while the current configuration is marked unchecked. Draft checks keep their own revision and do not mark a saved configuration checked. Enablement changes increment the connection revision without changing its configuration version. Expiry and cancellation outcomes remain visible. The cancellation-in-progress hint appears only for queued or running checks with a cancellation request; terminal checks hide it even when the saved request flag remains set. Unavailable management blocks writes while allowing refresh.

<a id="cloud-stdio"></a>
### Cloud STDIO

The generic Cloud STDIO section manages literal programs, JSON argument arrays and relative working directories. Users select an existing Session before saving or requesting discovery. Saving grants no start permission; discovery requires independent approval. The section displays persisted task details, cancellation requests and original-request reconciliation after lost replies. Closing the section retains unresolved requests within the same authenticated page instance. Unavailable composition disables generic writes and displays the metadata error; it does not substitute a fixed connection or a successful empty catalog.

STDIO Session selectors preserve the receiver when calling native `Session.list` methods. Management request IDs can be generated on plain HTTP when `crypto.randomUUID` is unavailable. Cancelled reads do not start a later action query or report availability from a retired generation. When Platform reports management unavailable, historical connections remain visible as read-only records with a localized status, and management controls are removed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Native components and bounded browser transports</summary>

The [native entry](src/client/index.ts) binds the existing Skills panel and official bundle configuration. Browser HTTP adapters validate public records, preserve request IDs and revisions, and keep replacement credentials on direct Platform upload paths. The STDIO validators and bundled Zod disable dynamic code generation.

Client source tests do not import Host implementation modules. Explicit network and Port substitutes check transport, masking, UI state and stale replies; Host-schema admission and real Platform/Runner behavior belong to integration checks. Prepared factory checks require the absolute current `client.js` path in `POWER_EVOLVE_FACTORY_FILE`.

Client catalog fixtures read the current cloud-only versions and digests without modifying deployment assets. The [cloud-only checker](../scripts/cloud-check.mjs) owns source and prepared-artifact validation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Host bundle](../host/README.md) — native Agent and browser composition.
- [Application](../application/README.md) — authorization and controlled execution.
- [Connector worker](../connector-runner/README.md) — remote checks and approved actions.
- [Cloud migration scope](../CLOUD-MIGRATION-PLAN.md) — accepted product capabilities.

-----

<a id="model-experience"></a>
## Model Experience

### Skill trial drafts

#### What the model sees

Try skill prepares an editable draft beginning with `/{alias}` and a newline. The English template continues with `Use the “{name}” skill to help with my current task.`; the Chinese template uses `请使用“{name}”技能协助我处理当前任务。`. The client does not submit the draft; the native Conversation submission owns any eventual user message.

#### Token effect

Opening the draft adds no model-request tokens. If the user submits it, the resulting message contains the edited text. Installing or enabling a Skill updates server-owned capabilities; native Skill and Host consumers own any loaded instructions and request formatting.

#### KV Cache effect

The draft starts a new Conversation and does not rewrite an existing Session prefix. Editing it changes the later submitted message. This browser client sets no provider cache policy; reuse after native Skill selection belongs to the request consumer and provider.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Users and maintainers must retain these operation limits:

- An uncertain result requires original-request reconciliation or an explicit retry with the retained input; a new request ID is a new operation.
- Connection configuration or Skill installation grants no generic program start permission. Approval and current deployment capabilities remain authoritative.
- Browser substitutes and prepared factories do not establish real Platform, Runner, SDK or two-user isolation acceptance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Keep current runtime evidence in the owning migration records. Preserve native Slots, write-only credential fields, pinned identities and original request IDs when updating these adapters.

</details>
