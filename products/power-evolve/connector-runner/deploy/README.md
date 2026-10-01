# Local k3d Connector Runner preparation

English | [中文](README.zh.md)

This procedure prepares the [isolated Connector Runner](../README.md) for a local k3d cluster. The Platform gets a dedicated `pe-connector-*` namespace and a private kubeconfig with namespace-scoped rights to Pods, Services, Secrets, and NetworkPolicies. The Platform cannot manage Agent Sandboxes, Deployments, other namespaces, or the forbidden-listener fixture. A preparation operator applies that fixture separately. The Runner Pods created by the Platform have only a per-Pod token Secret and a memory scratch volume; they have no user Home or Workspace mounts. Keep this namespace separate from the writable Sandbox namespace.

## Prepare the image and scoped access

Use Node 22.19+, pnpm 11, Docker, k3d, and kubectl. The selected cluster needs a working `gvisor` RuntimeClass and NetworkPolicy enforcement. Set these values explicitly from the repository root; choose a new dedicated namespace and a private directory outside the repository:

```sh
export PE_K3D_CLUSTER=pe-e32-session-probe
export PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_CONNECTOR_NAMESPACE=pe-connector-local
export PE_CONNECTOR_PRIVATE_DIR="$HOME/.config/power-evolve/connector-runner"
export PE_CONNECTOR_KUBECONFIG="$PE_CONNECTOR_PRIVATE_DIR/connector-kubeconfig"
export PE_CONNECTOR_IMAGE=pe-connector-runner:s6-local
kubectl --context "$PE_KUBE_CONTEXT" get runtimeclass gvisor
node products/power-evolve/connector-runner/deploy/build-and-import.mjs
node products/power-evolve/scripts/prepare-connector-access.mjs
node products/power-evolve/connector-runner/deploy/prepare-forbidden-listener.mjs
```

By default, the image helper captures the source lock and Connector manifest, builds the package, and creates a temporary `pnpm deploy --legacy --prod --ignore-scripts --frozen-lockfile` artifact outside the repository with `strict-dep-builds=true`. Legacy deploy can resolve dependencies despite its frozen flag. Before Docker build or k3d import, the helper requires unchanged source files and matching production and optional lock metadata, including dependency edges, peer and platform constraints, and integrity values. Missing metadata or drift rejects preparation. This check compares lock metadata; it does not validate installed bytes or runtime architecture.

After validation, the helper builds the pinned-base Dockerfile from the artifact and imports the image into the named cluster. It removes the temporary artifact after success or failed preparation, validation, build or import. The root workspace install policy must remain strict; `ssh2` and `cpu-features` install scripts are denied.

The access helper creates only a `pe-connector-*` namespace, refuses an existing namespace without its ownership labels, and writes the token kubeconfig with mode 0600 under a private 0700 directory. It does not edit the Platform configuration. Treat the kubeconfig as a credential; never commit it or display its contents.

For a build without cluster import, use `--build-only`. This mode needs Node 22.19+, pnpm 11, Docker, and a tagged `PE_CONNECTOR_IMAGE`; it does not read `PE_K3D_CLUSTER` or invoke k3d. The helper prints `Built IMAGE` after building and removing its temporary artifact. Registry transfer and cluster import are separate release operations.

```sh
PE_CONNECTOR_IMAGE=pe-connector-runner:s6-local \
  node products/power-evolve/connector-runner/deploy/build-and-import.mjs --build-only
```

The listener helper applies a gVisor Deployment and ClusterIP Service named `power-evolve-forbidden-listener`, waits for readiness, and checks `/health` through the scoped Platform Service proxy. It uses the imported image with a fixed Node HTTP listener command and no Runner token or SSH credentials. Keep the Deployment running throughout Connector calls. The Service ClusterIP may change if the Service is recreated; read it again before configuring the Platform.

## Verify scope and configure the Platform

Run the following checks without printing the token:

```sh
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i create pods
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i list pods
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i create networkpolicies.networking.k8s.io
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i get services/proxy
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i create sandboxes.agents.x-k8s.io
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i create deployments.apps
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" -n "$PE_CONNECTOR_NAMESPACE" auth can-i list secrets
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" get namespaces
kubectl --kubeconfig "$PE_CONNECTOR_KUBECONFIG" get --raw "/api/v1/namespaces/$PE_CONNECTOR_NAMESPACE/services/http:power-evolve-forbidden-listener:8080/proxy/health"
kubectl --context "$PE_KUBE_CONTEXT" -n "$PE_CONNECTOR_NAMESPACE" get service power-evolve-forbidden-listener -o jsonpath='{.spec.clusterIP}'
```

The first four authorization checks return `yes`; the next three return `no`, and listing namespaces is forbidden. The health response is `{"healthy":true}`. Configure the Platform `SshRunnerConfig` with this kubeconfig path, namespace, image, `runtimeClassName: 'gvisor'`, and `forbiddenProbe` set to the Service ClusterIP and port 8080. Its `proveForbiddenListener` callback must query the fixed Service proxy and require a healthy response immediately before preparation and credential dispatch. Do not put the probe ClusterIP in the Runner's allowed egress target. The scoped Role permits `get/create/delete` on Pods, Services, Secrets, and NetworkPolicies, `list` on Pods to verify that execution has stopped before backup, and `get/create` on `services/proxy`; it has no cluster-level grant or Secret listing permission.

The Runner requires three consecutive denied TCP probes before `/health` is ready. A healthy Platform proxy check alone does not establish Runner egress isolation. Verify an allowed target connection and denial of the live forbidden listener from an identically labeled, policy-selected Pod in this namespace before using credentials. If denial is inconclusive, keep credential dispatch disabled. Do not set `CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL=1` unless the fixed listener remains independently healthy and the cluster's refusal behavior has been verified. The local procedure does not enable an SSH trial or contact an external target.

## Remove a disposable setup

For a disposable namespace created solely for this procedure, use an administrator context to delete that exact namespace, then remove its private kubeconfig directory. Stop Platform use of that kubeconfig first. Namespace deletion also removes the listener and scoped RBAC. Never run this against an active Connector or Sandbox namespace.
