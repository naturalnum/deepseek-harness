# Release image composition: local protocol acceptance

This record covers the three clean-source ARM64 images from [release build evidence](QA-RELEASE-BUILD.md) running together through the formal deployment entry points. The fixed cloud candidate remains unchanged. Native browser acceptance is incomplete: both available browsers rejected the temporary local HTTPS certificate. No browser security setting or system trust store was changed.

## Deployment scope

The deployment renderer is from `399896d103`. An isolated QA adapter retains its namespace separation, RBAC, NetworkPolicies, credentials projections, process entry points and security contexts. It replaces NFS with one dedicated hostPath behind the original PVCs, reduces Host and Platform to one replica each, and replaces public Ingress with a bounded local TLS proxy. The 35 resources run in the existing single-node k3d cluster. This does not establish production Ingress, NFS or physical-node failover.

| Image | Imported manifest digest |
| --- | --- |
| Application, initial protocol run | `sha256:61ef3bb0c925b15905b6f686477f833c4e2fc94fdc089188c0047f591ca1e64e` |
| Application, current SSH requalification | `sha256:c63cf1cb9d191c4fe5ffa13fa98fe2a216888a853aaccbdd3c4530260f5bb703` |
| Cloud Runner | `sha256:ce9a705b429721328c34e68869a940839ab05d17a601176e3b392ca7a056b67d` |
| Connector Runner | `sha256:d6febdee0e8048816841e1e51dc14a0c79f6d66015083110c2eeeacae1a94778` |

The QA database has a new non-superuser owner, separate data and fresh test login passwords. Files use a separate POSIX root. Model credentials come from the already-authorized private configuration. Runner images were imported; empty Docker credential Secrets test the configured references only. No authenticated private-registry pull occurred. The notes API and remote HTTP MCP are not configured in this composition.

The initial Platform startup was refused at the Kubernetes API. This CNI applies egress matching after service address translation: allowing `10.43.0.1:443` did not admit its endpoint `172.30.247.2:6443`. Setting the existing deployment values to that exact endpoint restored startup. No application authorization or policy enforcement was disabled.

The operator-side preflight correction in `98a3d0366f` rejects Pod isolation changes for both Host and Platform. Eight invalid manifest cases first reproduced acceptance of host network/PID/IPC sharing and a changed Pod security context. After the correction, 25 deployment and Connector checks passed, including rejection of process sharing, runtime selection and malformed namespace flags. Read-only inspection of the actual QA Deployments confirmed the expected Pod/container security contexts, no shared host namespaces, and a Host with no PVC or API token and only the worker credential projection. This correction does not change the running application image; `live-isolation.json` records the cluster inspection.

## Verified paths

All requests below use the real product HTTP protocols over HTTPS with the exact QA certificate supplied as the client CA. They are protocol acceptance, not browser automation. DeepSeek, PostgreSQL, gVisor Runners and the OpenSSH target are real services.

| Path | Observed result |
| --- | --- |
| Two native Sessions and `hi` | Both real-model turns completed; identical input IDs produced one operation each; another user's history returned 404; no execution record or Sandbox Pod was created |
| Files without execution | Each user wrote, reread and downloaded the exact Python fixture bytes; duplicate writes retained the receipt; foreign reads returned 404 and traversal returned 400; no Sandbox Pod was created |
| Cloud programming | The existing Sessions created two separate gVisor Pods using the dedicated Runner PVC; each initialized Git, committed the fixture, passed two Python tests and wrote its own marker; Platform file reads matched the Runner results |
| SSH authentication | Two personal private-key connections uploaded credentials directly to Platform; each authenticated against its own Unix account through an isolated Connector Runner; foreign call lookup returned 404 |
| Restart while awaiting approval | Host and Platform rolled over after an exact SSH action became pending; hashes of 93 events, seven operations, two cloud executions, one pending action and two SSH calls were unchanged |
| Approval and execution | An independent approval login authorized the exact command and directory; an Agent token returned 401 and another user's approval token returned 404; repeating the decision produced one SSH call with the expected account, directory and output |
| Recovery readback | Fresh logins read history equal to PG and downloaded the original workspace markers; exactly one SSH continuation completed; all three Connector calls completed cleanup; foreign execution-result lookup returned 404 |

The initial cloud driver checked execution too early, because a user turn may complete while its Sandbox result is still pending. It was corrected to observe the existing execution and continuation without resubmitting the command. The approval driver initially omitted the documented working-directory wrapper from its expected command; after inspecting that exact wrapper, the same pending proposal was verified and approved. Neither issue required a product code change.

Evidence resides in `.artifacts/power-evolve/release-integration/`: the nonsecret values and resource bundle, `hi-proof.json`, `files-proof.json`, `cloud-proof.json`, `ssh-auth-proof.json`, `recovery-before.json`, `recovery-after.json`, `ssh-execute-proof.json` and `readback-proof.json`. Private configuration remains outside the repository. The adapter's SHA256 is `0ac45c950e63d23d1ac2d180429a3070001adbfab6c31d2dd4e9c9a0fe2b7faa`.

## Application requalification

The clean application image from `447938c23258b36a63e6b9913fc3df6cf586857c` replaced only the QA Host, Platform and TLS-proxy image references after existing work settled. All three Pods became ready with the recorded imported digest. The fixed candidate, Runner images, credentials, database and storage roots were preserved. The only application runtime change since the initial image is the fenced SSH metadata; the other code correction affects operator preflight.

A fresh real-model Session received the fenced connection records, selected the existing connection by name and proposed the exact controlled SSH command. The independent approval login authorized it; the real Connector returned the expected account, working directory and marker with exit zero. PG recorded one call and one completed Session continuation, and Connector cleanup completed. Fresh logins also reread both users' earlier histories against PG and downloaded the unchanged cloud Workspace markers; another user's SSH result remained inaccessible. These are protocol checks over certificate-pinned HTTPS. Browser acceptance remains separate.

`application-requalified-rollout.json` records the image references and ready Pod identities; `ssh-requalified-proof.json` records the fresh command and continuation. `readback-proof.json` contains the post-update readback. Focused SSH tests, application compilation, the original Markdown-wrap check and README pairing passed before packaging. No unrelated full regression was repeated.

## Remaining gates

The new composition still needs native browser login, streaming, file controls and approval-page acceptance with trusted HTTPS. The local certificate expires after three days; trusting it requires the user's confirmation. This protocol result cannot close that browser gate. Private-registry pulls, the target architecture, external PostgreSQL, shared storage across physical nodes, production ingress, mixed-load capacity and organization identity integration remain subject to S7 target-environment acceptance. Existing fixed-trial evidence retains its recorded scope.
