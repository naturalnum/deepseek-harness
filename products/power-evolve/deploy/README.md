# PowerEvolve S7d deployment candidate

English | [中文](README.zh.md)

This directory renders a **candidate**, not a released production deployment. It runs the existing DSH Host and Platform bundles as two independent, two-replica Deployments. The Host uses an internal Platform Service for server-side calls and exposes its own HTTPS Origin; browser calls to Platform use a separate HTTPS Origin. The Platform alone gets PostgreSQL credentials, provider credentials, a shared POSIX volume, and a projected Kubernetes ServiceAccount token. Sandbox Pods run in a separate namespace without a ServiceAccount token.

The S7b `hostPath` and static kubeconfig trial remains available. Production configuration selects a PVC and an in-cluster, rotating ServiceAccount token. The Platform refuses execution configuration with both a node path and a PVC (or neither). Each Sandbox mounts only its Session Workspace, its user's Home, and its user's read-only Skill package subdirectory from the runner namespace PVC. The Platform compares those subpaths against the Sandbox and live Pod before use.

## Build and configure

Use a clean committed revision. An archive excludes local credentials, ignored build outputs, and `.git` from the Docker context. Build the common Host/Platform image and the existing runner image separately, push both, and use their **registry digest** references in a private copy of `values.example.json`. The example digests and domains deliberately fail the `--ready` gate.

```sh
git status --short
git archive HEAD | docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -f products/power-evolve/deploy/Dockerfile -t REGISTRY/power-evolve:REV -
git archive HEAD:products/power-evolve/sandbox | docker build -f Dockerfile -t REGISTRY/power-evolve-runner:REV -
docker push REGISTRY/power-evolve:REV
docker push REGISTRY/power-evolve-runner:REV
# Resolve each pushed reference to REGISTRY/name@sha256:<64-hex-digest>.
cp products/power-evolve/deploy/values.example.json /private/path/values.json
node products/power-evolve/deploy/render.mjs /private/path/values.json /private/path/power-evolve.yaml
node products/power-evolve/deploy/render.mjs /private/path/values.json /private/path/foundation.yaml foundation
node products/power-evolve/deploy/render.mjs /private/path/values.json /private/path/workloads.yaml workloads
node products/power-evolve/deploy/preflight.mjs /private/path/values.json /private/path/power-evolve.yaml --context YOUR_CONTEXT
```

Use external PostgreSQL with a trusted server certificate and a `sslmode=verify-full` connection URL. Provision the application namespace Secrets named by `secrets.shared` and `secrets.platform`; the keys are:

| Secret | Keys | Consumer |
| --- | --- | --- |
| shared | `worker-token` | Host and Platform |
| platform | `database-url`, `model-key`, `connector-key`, `runner-key`, `users.json`, `account-management.json` | Platform only |
| TLS | `tls.crt`, `tls.key` | Ingress controller |

The `users.json` format is the existing Platform seed-user format. Keep Secret creation outside the rendered bundle and your shell history. Use the same worker token in both replicas and both tiers. Rotate it as a coordinated rollout. The runner key signs per-Sandbox runner tokens and must stay Platform-only.

This seed format currently accepts at most 100 users, and each Platform replica hashes those seed passwords during startup. It is suitable for staged trials; enterprise account provisioning, revocation, and identity-provider integration are separate release gates for a large rollout.

The bundle declares two static `ReadWriteMany` NFS PVs, each bound to a PVC in its own namespace, both pointing to the **same server and export path**. The administrator must prepare that export for POSIX ownership changes by the Platform, and validate data and file permissions from both physical nodes. The Platform uses `/data` for both `sandboxLocalRoot` and `skillLibraryRoot`; the runner's PVC is accessed only through exact `subPath` mounts. An NFS export with root squash that prevents the Platform's required `chown` is incompatible until ownership is provisioned separately.

Platform `/health` tests PostgreSQL and controls readiness; `/live` tests the serving process without PostgreSQL and controls liveness. During a database outage, Platform Pods should leave Service endpoints without being restarted. Verify `restartCount` remains unchanged through an outage longer than three liveness intervals, then confirm the Pods become ready after PostgreSQL returns.

Set the real Ingress class, controller Pod labels, public DNS names, TLS Secret, and egress CIDRs in values. `runnerProxySourceCidrs` must identify the actual source IPs observed by Sandbox Pods for Kubernetes API Service proxy traffic. Set `apiServerCidrs` and `apiServerPort` to the API destination address and port that the CNI actually matches. If Service NAT changes that destination, measure the endpoint address and port; the example port 443 may not apply. The default-deny policies select every Pod in the application and writable runner namespaces; Host, Platform, and runner policies allow only the listed flows. Verify the CNI actually enforces these policies before traffic is admitted.

Apply only in an isolated namespace and after reviewing the rendered manifest. The bundle creates namespace-scoped ServiceAccounts, a Role and RoleBinding in the runner namespace, two Deployments/Services, TLS Ingress, and NetworkPolicies. It contains no Secret values. Apply the foundation first; then provision the referenced Secrets, registry pull Secrets (when configured), and TLS Secret in the new namespace. The cluster check expects bound PVCs and the RoleBinding; run it before applying workloads or opening public traffic. It is read-only.

Static preflight checks both Host and Platform Pod templates. It accepts only absent or boolean false values for host network, PID, IPC and shared process namespaces; Pod security context must exactly match the renderer, including UID/GID, filesystem group and seccomp settings. Runtime class, user namespace and OS selections must also match the renderer. Existing Secret projections, PVC mounts, ServiceAccounts and container security checks remain enforced. These checks validate the supplied manifest; actual admitted Pods and CNI enforcement require cluster acceptance.

```sh
kubectl --context YOUR_CONTEXT apply -f /private/path/foundation.yaml
# Provision the named Secrets through your secret manager.
node products/power-evolve/deploy/preflight.mjs /private/path/values.json /private/path/power-evolve.yaml --context YOUR_CONTEXT --ready
kubectl --context YOUR_CONTEXT apply -f /private/path/workloads.yaml
kubectl --context YOUR_CONTEXT -n YOUR_APP_NAMESPACE rollout status deployment/power-evolve-platform
kubectl --context YOUR_CONTEXT -n YOUR_APP_NAMESPACE rollout status deployment/power-evolve-host
```

On first installation, stage the foundation and workload resources through your normal change-control mechanism so `--ready` and the physical checks finish before Ingress admits traffic. `--ready` checks at least two Ready nodes, the Sandbox CRD/controller and gVisor RuntimeClass, Secret key presence, TLS SANs, bound PVCs, and allow/deny RBAC, including explicitly selected Service proxy subresource access. Expected permission denials pass; failed probes and unknown answers reject readiness. It intentionally does not print Secret values; it inspects the PostgreSQL URL shape and TLS certificate. A passing result is **not** proof of multi-machine POSIX consistency or ingress behavior.

## Account configuration

`account-management.json` contains `maxUsers`, a `models` catalog (`id`, `label`, `maxTokens`) and `initialSettings` (`model`, `maxTokens`). Both Platform replicas load the same private file. The Host receives neither this file nor administrator credentials. Local trials provision this file without promoting a seed user.

Administrator initialization is explicit: set `accounts.bootstrap` to `true` and add `account-bootstrap.json` to the Platform Secret. For an existing database it identifies `mode: "existing"`, the exact `userId` and `username`; for an empty database it uses `mode: "create"` and also supplies `displayName` and a private initial `password`. Omit bootstrap or set it to `false` after initialization. Its contents never enter rendered manifests. The account parser is shared by startup and the read-only readiness check; database initialization and account lifecycle acceptance are described in the [account slice](../S3-ACCOUNT-COMPLETION.md).

## Optional remote MCP

Omitting `remoteMcp` in values leaves the feature disabled. To enable it, provide `secretName` and `destinations`, where each destination has a canonical `origin`, exact literal-IP `addresses`, optional `allowHttp: true`, and optional `caKey`. A CA entry also requires `caConfigMapName`. The Secret must differ from the Host's shared Secret. The renderer adds only each origin's own TCP port and approved IPs to Platform egress; Host and runner policies remain unchanged.

Provision `remote-mcp.json` and `remote-mcp-key` in that Secret. The JSON uses the [Platform configuration](../platform/remote-mcp.example.json), with `requireOriginException: true` and `credentialKeyFile` set to `/run/power-evolve/private/remote-mcp/credential-key`. Its `internalExceptions` must match values destinations exactly; CA paths are `/run/power-evolve/private/remote-mcp/ca/<caKey>`. Store the referenced PEM entries in the declared CA ConfigMap. Only Platform receives these read-only projections and the fixed config path; rendered YAML contains no private bytes.

Platform startup validates the mounted material and strict origin mode. The read-only `--ready` check fetches only the named MCP Secret and CA ConfigMap, validates their contents with the runtime parser, and compares permissions with values. Rendering and local parser tests do not demonstrate actual CNI enforcement, Secret mounting or target connectivity; those checks remain part of physical acceptance.

## Optional process connectors

Leave `connectorRunner` absent or `null` to retain the default disabled behavior. To enable the existing isolated SSH and fixed STDIO transports, add:

```json
{
  "connectorRunner": {
    "namespace": "pe-production-connectors",
    "image": "registry.example.invalid/power-evolve-connector@sha256:3333333333333333333333333333333333333333333333333333333333333333",
    "proxySourceCidrs": ["192.0.2.30/32"],
    "sshDestinations": [{ "ip": "198.51.100.30", "port": 2222 }]
  }
}
```

Replace the example digest and addresses. The connector namespace must differ from both the application and writable cloud runner namespaces. Build and push the existing Connector Runner image, then use its immutable digest for both calls and the forbidden listener. `proxySourceCidrs` must be the observed API server proxy source addresses, each exactly `/32` or `/128`. SSH destinations are exact IPv4/port pairs, at most 32; DNS names and IPv6 SSH are rejected because the current Application SSH allowlist parser cannot accept IPv6. An empty `sshDestinations` array enables only the existing fixed `whoami` process MCP; it requires no SSH key and provides no arbitrary user process launch. This switch does not change the separate remote MCP origin-exception requirements.

When SSH destinations are nonempty, provision `ssh-credential-key` in the existing Platform Secret: a canonical base64url encoding of exactly 32 random bytes, shared by both Platform replicas and preserved with encrypted connection history. The existing Platform-only `connector-key` also controls per-call Runner authentication. No user SSH password, private key, encryption-key bytes or Kubernetes token belongs in values or rendered YAML. Users save personal SSH credentials through the existing direct-to-Platform upload form and approve each command on the trusted Platform page. Startup and readiness use the existing Application constructors to validate the key, allowlist and Runner settings before admission.

The connector Role allows only Pod/Service/Secret get/create/delete, Service proxy get/create and NetworkPolicy get/create/delete within the connector namespace. It grants no list/watch, Deployment, exec or RBAC management authority. Its RoleBinding names only the application's Platform ServiceAccount; cloud Role permissions remain unchanged. Connector and listener Pods have no API token, shared volume, user Home or Workspace mount. Host receives no additional configuration, credentials, egress or Kubernetes authority. The namespace starts with default deny; the listener permits only declared proxy sources on TCP 8080, and each call's existing orchestrator creates its own restricted policies. Fixed STDIO has no egress exception.

Both process orchestrators use the connector namespace's `default` ServiceAccount. The foundation configures its `imagePullSecrets` when `imagePullSecretName` is set, and the Platform profile explicitly passes the same reference to desired call Pods so recovery compares the exact admitted field. Provision that registry Secret in the connector namespace as well as the application and cloud runner namespaces. The listener uses the same digest and default ServiceAccount. A pre-imported local image does not verify registry credentials or admission.

With process connectors enabled, `foundation` includes the listener Deployment and Service as well as its namespace, ServiceAccount, RoleBinding and policies; `workloads` contains only the application Deployments/Services and public Ingress. After applying foundation and provisioning private material, wait for the listener to become Ready before `--ready` and application startup. Readiness checks the listener's current generation, pinned image, Service identity, actual Platform-impersonated Service proxy `/health`, and allowed/denied namespace permissions. Missing or malformed material, a stale listener or an unreachable control path fails the gate. This does not prove CNI denial from a real call Pod or connectivity to an SSH target; root's serial physical acceptance must verify those flows, registry pulls, approval, single Session continuation and resource cleanup.

## Physical acceptance gates

Before release, run on **two physical machines** with the production CNI, ingress controller, PostgreSQL, and NFS export:

1. Confirm Host Pods have no database environment, Platform Secret, PVC, or Kubernetes API token; deny Host and runner ServiceAccounts access to Secrets and Pods. Confirm the cloud Platform Role is limited to its writable runner namespace: `list` is allowed only for Sandboxes so backup can verify their absence. Deny Sandbox listing in other namespaces, Pod listing/creation, Secret listing, `watch`, and cluster-scoped PV/RBAC verbs.
2. Create a Sandbox on node A, write Workspace/Home/Git data and a Skill package, record its Pod UID, then stop it and verify kubelet-stop evidence. Start its replacement on node B; verify the same bytes and permissions, with no replay of an uncertain command. Check a second user cannot mount or read the first user's subpaths.
3. Exercise Host and Platform replica failure/rejoin, authenticated login and approval, native Web streaming and a long response through both public TLS Origins. Check browser Origin/CSP behavior, no Ingress retry of a failed POST, and session recovery against external PostgreSQL.
4. From each Pod, verify required DNS, PostgreSQL, model, connector, Kubernetes API, and runner proxy flows. Verify denied destinations and CNI policy enforcement, including the API server source IP actually seen at the runner.
5. Confirm NFS permissions, capacity, backup/restore, volume fencing, gVisor compatibility with PVC `subPath`, image pull on each node, rollout and rollback behavior under a real node outage.

The local k3d two-node S7b drill shared one physical host. It does not satisfy these gates. This template does not deploy a public model gateway, controlled connector API, or desktop Device service; supply the configured model and connector HTTPS endpoints. Optional process connectors use the separate namespace described above. Do not promote this candidate based solely on rendered YAML or local dry-run.
