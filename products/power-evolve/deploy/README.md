# PowerEvolve S7d deployment candidate

English | [中文](README.zh.md)

This directory renders a **candidate**, not a released production deployment. It runs the existing DSH Host and Platform bundles as two independent, two-replica Deployments. The Host uses an internal Platform Service for server-side calls and exposes its own HTTPS Origin; browser calls to Platform use a separate HTTPS Origin. The Platform alone gets PostgreSQL credentials, provider credentials, a shared POSIX volume, and a projected Kubernetes ServiceAccount token. Sandbox Pods run in a separate namespace without a ServiceAccount token.

The S7b `hostPath` and static kubeconfig trial remains available. Production configuration selects a PVC and an in-cluster, rotating ServiceAccount token. The Platform refuses execution configuration with both a node path and a PVC (or neither). Each Sandbox mounts only its Session Workspace, its user's Home, and its user's read-only Skill package subdirectory from the runner namespace PVC. The Platform compares those subpaths against the Sandbox and live Pod before use.

## Build and configure

Startup accepts operator-owned `PE_MAX_HISTORY_BYTES` and `PE_RUNTIME_MAX_RESPONSE_BYTES` on both roles. Defaults remain 8 MiB of persisted Session events and 12 MiB of snapshot transport. Set the same pair on every replica in a controlled rollout; the snapshot bound must exceed history by at least 4 MiB. Canonical decimal integers are required, with history capped at 64 MiB and transport at 96 MiB. For the long-report trial, 16 MiB history and 24 MiB transport are sufficient budget settings to test; they do not establish capacity or enlarge model context. Startup rejects invalid budgets before reading private material or writing a Profile. Raising a limit preserves existing history; reaching it rejects new appends and settles the operation as failed rather than replaying side effects.

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

## Local HTTP development deployment

`local-http.mjs` renders a separate single-machine development bundle. Set distinct `hostPublicOrigin` and `platformPublicOrigin` values to canonical loopback HTTP Origins, using the same hostname; for example, `http://127.0.0.1:19804` and `http://127.0.0.1:19806`. The remaining values use the fields described above, including immutable image digests and private Secret references. The cluster must already provide Agent Sandbox and gVisor, and each referenced Secret must be provisioned privately before starting the workloads.

```sh
node products/power-evolve/deploy/local-http.mjs /private/path/local-values.json /private/path/new-local-resources.json /var/lib/power-evolve-local 1 1
kubectl --context LOCAL_CONTEXT apply -f /private/path/new-local-resources.json
kubectl --context LOCAL_CONTEXT -n LOCAL_NAMESPACE rollout status deployment/power-evolve-platform
kubectl --context LOCAL_CONTEXT -n LOCAL_NAMESPACE rollout status deployment/power-evolve-host
kubectl --context LOCAL_CONTEXT -n LOCAL_NAMESPACE port-forward --address=127.0.0.1 service/power-evolve-host 19804:18880
kubectl --context LOCAL_CONTEXT -n LOCAL_NAMESPACE port-forward --address=127.0.0.1 service/power-evolve-platform 19806:18881
```

The output must be a new `.json`, `.yaml` or `.yml` file. The node path must be an isolated absolute directory inside the Kubernetes node, not the Mac path. Both PVs use that directory through `hostPath`; the original PVC mounts, Secret separation, resource authorization, RBAC and NetworkPolicies remain. The renderer removes Ingress, adds no public Service or proxy, and sets `PE_LOCAL_HTTP=1` in both application ConfigMaps. The startup entry permits only canonical loopback HTTP Origins in this mode; the default startup and production renderer still require HTTPS. The production preflight does not accept this local bundle.

The optional final arguments select one or two Host and Platform replicas independently; both default to one. Two replicas on one node test process failure and durable recovery, not physical-node failover or cross-machine POSIX consistency. Keep the two port-forward processes running during browser use and stop them when the trial ends. HTTP is for the loopback development trial; production HTTPS and physical deployment acceptance remain separate.

## Application backups

The operator entry [backup.mjs](backup.mjs) stops the exact Host and Platform Deployments before copying PG, four POSIX data trees and fixed private projections. Copy [backup.example.json](backup.example.json) into a private `0600` file and replace its scope, digest, database identity and paths. `storageRoot` is the operator-visible mounted filesystem root; a Kubernetes node path alone is insufficient. Materialize `private.projectedRoot` as real `0700` directories and `0600` files at the product's fixed projection paths. Enable the SSH, MCP and Notes CA switches that match the deployment. Freeze deployment/configuration changes and external file writers during backup; keep deployment values separately for rebuilding resources.

`postgres.urlFile` is a private URL file; database and role must match the Node/libpq destination. Optional `container` selects an existing PG tools container; `host`, `port` and `binDir` select its transport or local tools. `commandTimeoutMs` defaults to 900000 and accepts 1000–3600000. The role needs the identity/catalog reads used by preflight. Credentials do not enter tool arguments or error output. The formal entry requires built product verifiers and writes format-4 bundles and reads formats 3 and 4; the process-trial entry writes format 3 and reads formats 1–3.

```sh
node products/power-evolve/deploy/backup.mjs create /private/path/source.json
node products/power-evolve/deploy/backup.mjs resume /private/path/source.json
node products/power-evolve/deploy/backup.mjs restore /private/path/target.json
```

Create saves stop intent and original UID/spec/replica counts, stops Host before Platform, and requires settled PG work and no execution writers. Pending approvals remain pending. Ambiguous requests are read back without automatic replay or writer resumption. Explicit `resume` restores source replicas; readiness is a separate gate. Inspect the private fence before retrying; remove a stale `.lock` only after verifying its recorded process has exited.

When Office previews are configured, set `officePreview` to `{ "configFile": "/private/path/office-preview.json", "cacheRoot": "/mnt/power-evolve/office-previews" }`; otherwise omit it or use `null`. Both paths must be explicit, physical and separate from protected data, private projections and the bundle. The configuration must match its runner namespace. Its `localRoot` is the container view; `cacheRoot` is the explicitly selected operator-visible physical tree, just as `storageRoot` is. They may differ. The bundle records both paths without rewriting configuration bytes or inferring a mount from tasks. The operator verifies the mount mapping; backup verifies the selected tree against all recorded source/result/PDF bytes and its complete inventory. The bundle retains its original private configuration, complete cache inventory, original input/result/PDF bytes and a digest of the Office job census. Create rejects active jobs, reserved parser slots and every remaining parser Pod, including finished or deleting Pods; terminal job state alone does not prove shutdown.

The target supplies a private Office configuration separate from original roots, the bundle and fresh data/private projections, plus an absent physical cache root. Restore checks that no target parser Pods exist before copying and after PG restoration. Only `namespace`, `volumeClaimName`, `volumeSubPath` and `localRoot` may differ from the source configuration; the target namespace must match its runner scope. Restore copies original cache bytes and verifies their PG bindings against the actual restored database before reporting success. Configuration placement changes alter the provider generation: old result bytes remain preserved, but current preview APIs may reject historical generations. A new conversion is a new request, not proof of restored historical output.

Old bundles have no Office census. After `pg_restore`, restore rejects them if admitted Office records need omitted cache bytes, before success or startup. The target remains stopped and partial; inspect it and use a fresh target rather than blindly replaying restore. Cancellation-only or pre-Office records do not require cache bytes.

Restore verifies bytes, separate roots/namespaces and an independent empty database before mutation. It preserves key bytes and historical Skill versions, prepares execution ownership, and keeps the target stopped. The target supplies its own database URL; source URLs, `model.env`, generated Profiles and running processes are not restored. A failed partial target stays stopped: inspect it and prepare a fresh empty target before retrying. Recreate Secrets/resources from reviewed target values, then perform deployment and two-user acceptance. The [local recovery record](QA-RELEASE-COMPOSITION.md#formal-image-stopped-backup-and-data-restore) distinguishes recovered bytes from application readiness.

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

## Optional Office previews

Omit `officePreview` or set it to `null` to keep previews disabled. To enable it, copy the explicit budgets from [the parser configuration example](../platform/office-preview.example.json) into an `officePreview` values object, omit `namespace`, `volumeClaimName`, `volumeSubPath` and `localRoot`, and add `configMapName` plus `imageAccess: "public"` or `"preloaded"`. Supply the immutable parser image and actual `fontPolicyDigest`; all limits, resource budgets, slot/retention counts and reconciliation timers are required. The example starts with one parser slot, 1 CPU and 3 GiB, which requires separate workload-capacity verification.

Foundation contains the named ConfigMap. Only Platform projects its JSON at `/run/power-evolve/private/office-preview.json` and uses in-cluster Kubernetes access; Host receives only the feature flag. Startup validates the JSON before writing a Profile. The parser uses the existing runner namespace and PVC, with exact job input/output subpaths beneath `office-previews` and Platform preparation at `/data/office-previews`. The existing runner Role adds only Pod create/delete to get/patch. Parser Pods have no API token, credentials, Workspace/Home mount or network exception; the existing namespace default deny remains in force.

`imageAccess` is an operator declaration, excluded from the converter generation. Public images require no registry authentication. Preloaded images use the existing `IfNotPresent` policy; `--ready` requires the exact immutable reference in `status.images.names` on every Ready, uncordoned node without NoSchedule/NoExecute taints. This observation does not execute a parser or verify cross-node storage. Parser private registry pulls are unsupported; the application's separate `imagePullSecretName` still applies to its existing consumers. Do not rely on a default ServiceAccount's registry credentials for parser admission.

Preflight reads only the named Office ConfigMap, compares its bytes with values, and runs the built Application loader. Build the Application before running deployment tests or preflight outside the application image. `local-http.mjs` inherits the same optional settings while retaining its single-machine HTTP limitations. Actual parser launch, input/output ACLs, rendering, cancellation and exact Pod termination remain cluster-acceptance checks owned by the deployment operator.

## Physical acceptance gates

Before release, run on **two physical machines** with the production CNI, ingress controller, PostgreSQL, and NFS export:

1. Confirm Host Pods have no database environment, Platform Secret, PVC, or Kubernetes API token; deny Host and runner ServiceAccounts access to Secrets and Pods. Confirm the cloud Platform Role is limited to its writable runner namespace: `list` is allowed only for Sandboxes so backup can verify their absence. Pod create/delete is allowed only when Office previews are enabled. Deny Sandbox listing in other namespaces, Pod listing, Secret listing, `watch`, and cluster-scoped PV/RBAC verbs.
2. Create a Sandbox on node A, write Workspace/Home/Git data and a Skill package, record its Pod UID, then stop it and verify kubelet-stop evidence. Start its replacement on node B; verify the same bytes and permissions, with no replay of an uncertain command. Check a second user cannot mount or read the first user's subpaths.
3. Exercise Host and Platform replica failure/rejoin, authenticated login and approval, native Web streaming and a long response through both public TLS Origins. Check browser Origin/CSP behavior, no Ingress retry of a failed POST, and session recovery against external PostgreSQL.
4. From each Pod, verify required DNS, PostgreSQL, model, connector, Kubernetes API, and runner proxy flows. Verify denied destinations and CNI policy enforcement, including the API server source IP actually seen at the runner.
5. Confirm NFS permissions, capacity, backup/restore, volume fencing, gVisor compatibility with PVC `subPath`, image pull on each node, rollout and rollback behavior under a real node outage.

The local k3d two-node S7b drill shared one physical host. It does not satisfy these gates. This template does not deploy a public model gateway, controlled connector API, or desktop Device service; supply the configured model and connector HTTPS endpoints. Optional process connectors use the separate namespace described above. Do not promote this candidate based solely on rendered YAML or local dry-run.

## Process-trial backups

The process entry [backup-trial.mjs](../scripts/backup-trial.mjs) uses `create|restore` with explicit `PE_BACKUP_BUNDLE`, `PE_TRIAL_NAME` and `PE_PRIVATE_DIR`. For Office, provide both absolute `PE_BACKUP_OFFICE_CONFIG_FILE` and `PE_BACKUP_OFFICE_CACHE_ROOT`, plus `PE_BACKUP_OFFICE_KUBECONFIG_FILE` for independent Pod-absence evidence from that file's current context. A restore uses target configuration and placement, with the same constraints as Application backups. Set `PE_BACKUP_KEEP_STOPPED=1` for Office restore; the process startup entry does not forward Office configuration. Rebuild reviewed deployment settings and validate readiness separately. Keep the source stopped during capture by setting this flag for create as well.
