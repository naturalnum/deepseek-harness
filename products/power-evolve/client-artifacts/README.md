# PowerEvolve artifacts client

English | [中文](README.zh.md)

This plugin adds explicit publication from the viewed Session’s Workspace and an artifact tab to the native DSH right sidebar. Publication creates an immutable platform-owned copy with metadata in PostgreSQL. Preview and download use the platform’s per-user authorization checks.

PDF, XLSX, DOCX and PPTX catalog previews open the native document sidebar using the artifact’s original Session and exact `/artifacts/<UUID>/<filename>` address. Text and image previews remain in the catalog. Immutable artifact documents offer no publication action.

Native `cloud_exec` receipts associate execution identities with their invoking turn. The `conversation.chat.turnTail` contribution displays file paths, sizes and SHA-256 versions returned by the Platform’s `executionFiles` API; tool receipts, stdout and Assistant prose supply no file facts. Partial or unavailable results state their limitations. A durable `power-evolve-execution` message source is associated with its native turn after input admission and supplies verified files to that turn’s closing inline mentions, including when the original receipt is outside the loaded history window. When that receipt is loaded, the client also checks its call ID against the reply; the Platform verifies Session and call ownership for every query.

Inline code resolves only an exact verified path or a unique verified basename within the viewed Session and closing. Repeated paths retain their execution versions on the original rows; inline mentions use the newest version available at their closing. Ordinary file previews remain available through the native file UI.

Clicking a verified file explicitly publishes and downloads its displayed version. Publication includes `expectedRevision`, reuses the same request ID on retry, and reports a changed source instead of publishing a newer version. Pending facts are polled at most 20 times, with at most two concurrent reads and 20 unique executions per request. Closing or hiding the view, switching Session, and unloading the plugin cancel observations and pending actions. Refresh reads durable Platform facts. The ordinary preview publication action may omit `expectedRevision`.

See [S2 interfaces](../S2-INTERFACES.md) and the [S2 trial](../TRIAL-S2-NATIVE.md).
