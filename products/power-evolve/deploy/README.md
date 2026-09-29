# PowerEvolve S7d deployment candidate

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
| platform | `database-url`, `model-key`, `connector-key`, `runner-key`, `users.json` | Platform only |
| TLS | `tls.crt`, `tls.key` | Ingress controller |

The `users.json` format is the existing Platform seed-user format. Keep Secret creation outside the rendered bundle and your shell history. Use the same worker token in both replicas and both tiers. Rotate it as a coordinated rollout. The runner key signs per-Sandbox runner tokens and must stay Platform-only.

This seed format currently accepts at most 100 users, and each Platform replica hashes those seed passwords during startup. It is suitable for staged trials; enterprise account provisioning, revocation, and identity-provider integration are separate release gates for a large rollout.

The bundle declares two static `ReadWriteMany` NFS PVs, each bound to a PVC in its own namespace, both pointing to the **same server and export path**. The administrator must prepare that export for POSIX ownership changes by the Platform, and validate data and file permissions from both physical nodes. The Platform uses `/data`; the runner's PVC is accessed only through exact `subPath` mounts. An NFS export with root squash that prevents the Platform's required `chown` is incompatible until ownership is provisioned separately.

Set the real Ingress class, controller Pod labels, public DNS names, TLS Secret, and egress CIDRs in values. `runnerProxySourceCidrs` must identify the actual source IPs observed by Sandbox Pods for Kubernetes API Service proxy traffic. `apiServerCidrs` must cover the API endpoint that the Platform's in-cluster client reaches. The default-deny policies select every Pod in both namespaces; Host, Platform, and runner policies allow only the listed flows. Verify the CNI actually enforces these policies before traffic is admitted.

Apply only in an isolated namespace and after reviewing the rendered manifest. The bundle creates namespace-scoped ServiceAccounts, a Role and RoleBinding in the runner namespace, two Deployments/Services, TLS Ingress, and NetworkPolicies. It contains no Secret values. Apply the foundation first; then provision the referenced Secrets, registry pull Secrets (when configured), and TLS Secret in the new namespace. The cluster check expects bound PVCs and the RoleBinding; run it before applying workloads or opening public traffic. It is read-only.

```sh
kubectl --context YOUR_CONTEXT apply -f /private/path/foundation.yaml
# Provision the named Secrets through your secret manager.
node products/power-evolve/deploy/preflight.mjs /private/path/values.json /private/path/power-evolve.yaml --context YOUR_CONTEXT --ready
kubectl --context YOUR_CONTEXT apply -f /private/path/workloads.yaml
kubectl --context YOUR_CONTEXT -n YOUR_APP_NAMESPACE rollout status deployment/power-evolve-platform
kubectl --context YOUR_CONTEXT -n YOUR_APP_NAMESPACE rollout status deployment/power-evolve-host
```

On first installation, stage the foundation and workload resources through your normal change-control mechanism so `--ready` and the physical checks finish before Ingress admits traffic. `--ready` checks at least two Ready nodes, the Sandbox CRD/controller and gVisor RuntimeClass, Secret key presence, TLS SANs, bound PVCs, and allow/deny RBAC. It intentionally does not print Secret values; it inspects the PostgreSQL URL shape and TLS certificate. A passing result is **not** proof of multi-machine POSIX consistency or ingress behavior.

## Physical acceptance gates

Before release, run on **two physical machines** with the production CNI, ingress controller, PostgreSQL, and NFS export:

1. Confirm Host Pods have no database environment, Platform Secret, PVC, or Kubernetes API token; deny Host and runner ServiceAccounts access to Secrets and Pods. Confirm the Platform Role is limited to its runner namespace and excludes list/watch and cluster-scoped PV/RBAC verbs.
2. Create a Sandbox on node A, write Workspace/Home/Git data and a Skill package, record its Pod UID, then stop it and verify kubelet-stop evidence. Start its replacement on node B; verify the same bytes and permissions, with no replay of an uncertain command. Check a second user cannot mount or read the first user's subpaths.
3. Exercise Host and Platform replica failure/rejoin, authenticated login and approval, native Web streaming and a long response through both public TLS Origins. Check browser Origin/CSP behavior, no Ingress retry of a failed POST, and session recovery against external PostgreSQL.
4. From each Pod, verify required DNS, PostgreSQL, model, connector, Kubernetes API, and runner proxy flows. Verify denied destinations and CNI policy enforcement, including the API server source IP actually seen at the runner.
5. Confirm NFS permissions, capacity, backup/restore, volume fencing, gVisor compatibility with PVC `subPath`, image pull on each node, rollout and rollback behavior under a real node outage.

The local k3d two-node S7b drill shared one physical host. It does not satisfy these gates. This template also does not deploy a public model gateway, controlled connector API, desktop Device service, SSH runner, or MCP runner; supply the configured model and connector HTTPS endpoints and deploy optional services separately. Do not promote this candidate based solely on rendered YAML or local dry-run.
