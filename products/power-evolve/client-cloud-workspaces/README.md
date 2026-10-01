# PowerEvolve cloud Workspaces client

English | [中文](README.zh.md)

This product plugin fills the native Workspace picker's hero and sidebar directory flows with one shared modal. Operators create a new private directory, browse an authenticated storage space and select an existing directory, or recover an existing Workspace whose storage binding is missing. Directory navigation and pagination show canonical paths relative to private storage; physical roots and credentials stay in the trusted Platform. Existing nonempty directories can be selected; the Platform rejects a directory that overlaps another active Workspace.

Creation carries the shared `workspaceCreateSelection` through the native Workspace Controller as an opaque `power-evolve-cloud-selection:` value. Creation and mkdir retain the same request identity while an identical attempt is uncertain. Only the native owner's explicit successful adoption clears a creation retry record; a new same-name intent then receives a new identity. The two modal entries share interaction records through a declared store, and receive plain authenticated operation callbacks.

Recovery keeps the original Workspace and Session identities, compares the exact observed binding generation, and uses a durable request identity for status queries. Missing-binding metadata carries that identity so an operator can resume after refreshing the page. Accepted or stopping requests lock target editing; only a validated completed receipt reports success. A confirmed blocked request allows an explicit replacement target with a new request identity. The Host's native Workspace follow stream refreshes the original row. Closing the modal aborts browser reads and status requests; it does not cancel a durable Platform recovery. Late responses cannot update an unloaded flow.

## Model experience

The plugin adds no model-visible messages or Session events. A Session binds its Workspace when created; choosing a visible project never rebinds an existing Session. Deterministic regressions use the production client Loader and native Workspace picker, shared Host RPC records, and owner-local English and Chinese output snapshots.

See [S2 interfaces](../S2-INTERFACES.md) and the [S2 trial](../TRIAL-S2-NATIVE.md).
