---
kind: upgrade-guide
description: "Cloud account MCP connections require an exact endpoint selected in the Root configuration."
---

# Approve Cloud HTTP MCP endpoints

English | [中文](guide.zh.md)

## Change

Cloud users could connect to HTTP MCP endpoints from account settings. Now their accounts can connect only to endpoints the deployment administrator selects. When the selection is empty or omitted, saved definitions remain visible and can be disabled or removed. Blocked connections show a policy notice and expose zero tools.

## Migration

1. Confirm which MCP services the deployment should reach. In the active Cloud Root profile, set `approvedConfiguration.mcp.allowedEndpoints` to those complete HTTP(S) URLs. Match the scheme, hostname, port, path and query. Use publicly routable endpoints that answer directly with no redirects. Enter credentials through account settings. See the [MCP policy](../../../../packages/cloud/pe-cloud-api/README.md).
2. Keep a copy of the previous Root profile and apply the updated profile through your deployment's normal restart. In an ordinary account, open **Settings → MCP connections**. Test an approved saved endpoint and confirm its tools appear. Confirm any remaining blocked definitions show the policy notice.
3. For rollback, restore the previous Root profile and matching application version before restarting. The previous version resumes its original connection behavior for enabled definitions. Disable any saved connection that should stay inactive before rolling back.
