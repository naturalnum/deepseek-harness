# Agent Note: PowerEvolve cloud Workspaces and artifacts in native Web

Status: implemented

English | [中文](2026-09-29-power-evolve-cloud-workspaces-artifacts-web.zh.md)

## Problem

PowerEvolve needs multiple cloud Workspaces and immutable published artifacts while retaining the native DSH Web navigation and file browser. A second project picker or file tree would split the Session and file state across competing interfaces.

## Decision

The product cloud Workspace plugin occupies both existing `directoryFlow` slots. Its title form gives the native Workspace owner an opaque, encoded title in the existing `path` field. The Host validates that encoding, creates the Workspace through the platform, and returns the new authoritative Workspace row. The native Workspace controller then selects the platform-generated ID. Every Workspace may display `/workspace` as its execution path; neither that path nor the title is an authorization key.

The product artifact plugin contributes an explicit Publish action to the native document preview toolbar for its selected file. It sends the Session ID, validated Workspace-relative path, and stable request ID through the authenticated product route. A native right-Sidebar page lists artifacts for the current Session or its Workspace, requests bounded preview data, and links to the authenticated streaming download route. The platform owns file authorization, immutable copies, and artifact metadata; the browser does not infer publication from model output.

The existing composer upload and document preview edit/download actions pass the active Session ID on every file request. An edit retains the Session ID from its read and refuses to save under a different Session; missing Session context disables the preview actions. The native file tree already reads through Session-scoped Remotes.

## Alternatives considered

**Build a separate cloud Workspace picker and file tree.** That would duplicate the native selection and file state and require two navigation paths for the same Session. The existing slots already provide the required user gestures.

**Publish files inferred from model replies.** A reply is not an authorized file selection and may name a stale or nonexistent path. Publication starts from the file the user selects in the native preview.

## Consequences

- Workspace creation and artifact publication remain visible through existing DSH Web controls, with no duplicate picker or file tree.
- Native Workspace rows remain distinct by platform ID even when their execution paths are equal.
- A failed publish can retry with the same request ID; a published artifact is retrieved independently of later changes to its source file.
