# PowerEvolve

English | [中文](README.zh.md)

PowerEvolve lives separately from upstream DSH within the same repository. Start development with the [architecture decision](ARCHITECTURE.md), or use the [desktop and cloud trial guide](TRIAL-SLICE5.md). Earlier [slice 4](TRIAL-SLICE4.md), [slice 3](TRIAL-SLICE3.md), [slice 2](TRIAL-SLICE2.md), and [slice 1](TRIAL.md) trials remain isolated.

```mermaid
flowchart LR
  C[网页客户端] --> H[共享 DSH 宿主]
  C -->|登录| P[可信平台后台]
  C -->|独立审批| P
  H -->|用户请求与任务授权| P
  P --> DB[(PostgreSQL)]
  P --> FS[(私有 POSIX 工作区)]
  P --> M[模型 API]
  P --> A[受控远程 API]
  P --> K[k3s / Agent Sandbox]
  K --> FS
  D[本地设备 Profile] -->|设备令牌与任务| P
  D --> L[(获授权的本地项目)]
```

| Directory | Responsibility |
| --- | --- |
| `application/src/host` | User RPC, event subscriptions, scheduling, native Session persistence and model adapters |
| `application/src/platform` | Identity, ownership, PG transactions, task leases, events, credentialed calls, and Sandbox management |
| `application/src/device`, `device` | Local-only device UI, directory grants, durable command journal, and bounded Docker execution |
| `application/web` | Conversation, files, skills, execution target selection, and a separate trusted approval page |
| `sandbox`, `k8s` | Per-Sandbox command runner and namespace-scoped platform RBAC |
| `host`, `platform` | Plugin composition and deployment settings for the two DSH Profiles |
| `application/tests` | Regression tests using real PG and actual Profiles |
| `scripts` | Local configuration and process management |

All product packages are private. The root Host TypeScript build includes product code. `pnpm run test:power-evolve` runs product integration tests; the upstream default test command remains responsible for native packages. Product plugins use public services from the selected baseline without changing the Agent loop or native Session format.

Recorded conversations live in the [PowerEvolve snapshot](../../../snapshots/power-evolve/conversation/snapshot.yml). Product tests use its user input and assistant response and compare the complete Session event by event. This Profile requires real PG and runs through the product test command; the four native `test:snapshot` Profile adapters do not own it.
