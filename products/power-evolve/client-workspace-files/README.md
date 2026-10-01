# Native Workspace files

English | [中文](README.zh.md)

This product client extends the native DSH composer, document preview and Files tab with authorized upload, edit and download actions. The [application](../application/README.md) owns authentication and storage access.

Files selection belongs to the viewed Session, tab and root. Hiding a tab retains its selection; closing it clears the selection and cancels preparation. One selected file downloads its original bytes; multiple files download a ZIP with relative directories. The browser owns transfer progress and cancellation. Preparation failures retain the selection for retry; [S2 file completion](../S2-COMPLETION.md) defines limits and verification.

The client bundle includes the shared download validators with Zod JIT disabled for the page CSP. It uses the native Files row and toolbar extension slots; no separate file tree or execution environment is created. Selection state has one owner, so it needs no independent runtime invariant installer.
