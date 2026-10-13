# S6 final native browser acceptance

迁移前快照 `4acb888058b3e5a95ec7d085ba75bcf2442d3636` 的链接用于查阅历史源码和 QA 附件；验收范围仍以本页记录的测试版本、结果和发布边界为准，不能据此认证当前云端版本。

Tested on 2026-09-30 in an isolated worktree whose product source matches `dd38d5b5dd`. The first SSH pass ran on `e82917b6fa`; after the `d152958970` SSH scheduling fix and `1e614a5e8b` STDIO recovery fix were included, SSH and STDIO were exercised again. The trial remains available for review.

## Try the retained trial

1. Open <http://127.0.0.1:19371/login>. Read either Alice's or Bob's trial password from the private `users.json` file in the directory below; do not copy it into a chat or repository. Login opens the native DSH Web at <http://127.0.0.1:19370/native/>.
2. In the native Plugins page, inspect your own SSH connection and fixed process MCP. Ask the Agent to call `mcp__stdio__whoami` in a cloud Session; its result should return to the same Session without exposing the other user's account ID.
3. In a fresh cloud Session, ask the Agent to propose `qa:ping` using your listed SSH connection and then stop. Open <http://127.0.0.1:19371/approval>, log in separately, inspect the exact command and target, and approve. The Session should later show `qa:ssh-ok` after a refresh. To try rejection, propose a new `qa:ping` and reject it; no Runner call should be created.
4. Repeat with the other trial account. Its Plugins entries, SSH approvals and Session history should remain separate.

Manage this isolated trial from `/Users/jingchao/agent_work/main_agent/power-evolve-s6-final-qa` with the following environment. `status` has been verified after final QA; `stop` preserves PG data and private configuration. Logs are in that worktree's `.artifacts/power-evolve/native-s6-final-f2/` directory.

```sh
export PE_TRIAL_NAME=native-s6-final-f2 PE_DATABASE_PORT=18534
export PE_HOST_PORT=19370 PE_PLATFORM_PORT=19371 PE_TARGET_PORT=19372
export PE_PRIVATE_DIR=/Users/jingchao/.config/power-evolve/shared-host-native-s6-final-f2
export PE_SSH_ENABLED=1 PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs status
node products/power-evolve/scripts/trial.mjs stop
node products/power-evolve/scripts/trial.mjs up
```

This trial uses a fixed read-only STDIO MCP preset and an allowlisted SSH test target. Production multi-node storage, ingress, global capacity and backup recovery remain S7 work.

| Item | Isolated acceptance value |
| --- | --- |
| Trial | `native-s6-final-f2` |
| Host | <http://127.0.0.1:19370> |
| Platform and trusted approval | <http://127.0.0.1:19371/approval> |
| Target API | <http://127.0.0.1:19372> |
| Private login/configuration files | `/Users/jingchao/.config/power-evolve/shared-host-native-s6-final-f2` |
| PostgreSQL port | `18534` |
| k3d context / fixture namespace | `k3d-pe-e32-session-probe` / `pe-connector-qa-d2e2524b` |
| Runner image | `pe-connector-runner:s6-final-e829` (Runner source unchanged by later Platform fixes) |
| Alice/Bob configured model | `deepseek-flash` via the live DeepSeek API |

The retained SSH fixture proved a pinned Ed25519 host key, password authentication, `qa:ping` returning `qa:ssh-ok\n`, and denial of an unrelated destination while its forbidden listener was healthy. Its scoped kubeconfig cannot create Deployments or read namespaces. The native SSH Plugins flow installed each user's private connection, checked authentication in a real Runner, rejected a wrong fingerprint and an unallowlisted destination, and verified credential retry without changing the stored credential.

The new [`qa-ssh-execute-browser.mjs`](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/scripts/qa-ssh-execute-browser.mjs) used separate native Web and trusted Platform approval browser contexts for both users. For each user, a real model called `ssh_execute_propose` for exactly `qa:ping`. Before approval, PG contained a sealed command and no `pe_ssh_calls` row or Runner Pod. The approval page showed the exact command, target and keyed fingerprint. Alice and Bob each approved in their independent approval session; each got `ssh.execute` output `qa:ssh-ok\n` from a distinct gVisor Runner Pod, a completed continuation in the original Session, and a refreshed native transcript. A separate Bob request was rejected: it continued the original Session without a Runner call. The other user's Host status and approval decision returned 404, and their approval list omitted the action. The stored call result stayed empty while the Platform held encrypted output.

The final `dd38d5b5dd` SSH pass produced approved Pod UIDs `bfd6af2f-2d5f-4514-ae9d-b71fcc62c61d` (Alice) and `710158d3-2c39-43c0-a9fa-a841b9ecb48e` (Bob); the rejection had no Pod UID. Results are retained with mode 0600 in `qa-ssh-execute-results-dd38.json` under the private directory. A subsequent trial restart preserved all three actions, their exact approval-page commands, owner-scoped Host results and completed same-Session continuations.

The existing [`qa-stdio-browser.mjs`](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/scripts/qa-stdio-browser.mjs) installed, disabled and re-enabled the fixed STDIO Process MCP for both users in native Plugins. Each live model called `mcp__stdio__whoami` once. Alice and Bob returned their own `user:<id>` from distinct gVisor Pod UIDs `07e11660-4708-40f6-883a-36e2b73d3f0c` and `e3f628e0-286d-4aae-9c4c-c90c3c49ebf5`; PG and refreshed native transcripts showed completed continuations in the original Sessions. Cross-user toggle and status requests returned 404. The script restarted the same trial and confirmed connection revisions, call results and transcripts survived. The Platform health endpoint reported schema 18, `sshAvailable: true` and `stdioMcpAvailable: true`. After all runs, the fixture namespace had zero `pe-cr-*` or `pe-mcp-*` resources.

The trial login files contain credentials and remain private. No password, approval bearer token or SSH credential is in this report or the browser script output.

## V17 to V18 copy migration

The stable `native-s6-combined-c1` PostgreSQL database on port `18533` was a read-only source. `pg_dump --format=custom` wrote a mode 0600 snapshot under the final trial's private directory. It was restored into `pe_s6_v17_clone_f3`, a separate database in the final trial's PostgreSQL on port `18534`. The source trial was neither stopped nor given schema initialization. [`qa-v17-v18-clone.mjs`](https://github.com/naturalnum/deepseek-harness/blob/4acb888058b3e5a95ec7d085ba75bcf2442d3636/products/power-evolve/scripts/qa-v17-v18-clone.mjs) connected to the source with read-only transactions, checked that both started at V17 with equal row content, ran the current `initializeDatabase` only on the clone, then confirmed clone V18 and source V17. It compared all preexisting fields as JSON and verified readable rows and unchanged hashes in seven tables: 2 users, 4 Sessions, 4 operations, 3 SSH connections, 6 SSH calls, 2 STDIO connections and 2 STDIO calls. The V18 SSH action table exists only in the clone. The migrated clone remains available for inspection.
