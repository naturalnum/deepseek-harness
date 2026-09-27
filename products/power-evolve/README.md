# PowerEvolve

English | [中文](README.zh.md)

PowerEvolve lives separately from upstream DSH within the same repository. Start development with the [architecture decision](ARCHITECTURE.md), or use the [slice 1 trial guide](TRIAL.md).

```mermaid
flowchart LR
  C[网页客户端] --> H[共享 DSH 宿主]
  C -->|登录| P[可信平台后台]
  H -->|用户请求与任务授权| P
  P --> DB[(PostgreSQL)]
  P --> M[模型 API]
```

| Directory | Responsibility |
| --- | --- |
| `application/src/host` | User RPC, event subscriptions, scheduling, native Session persistence and model adapters |
| `application/src/platform` | Identity, resource ownership, PG transactions, task leases, events, model credentials and egress |
| `application/web` | Login and two-user conversation pages |
| `host`, `platform` | Plugin composition and deployment settings for the two DSH Profiles |
| `application/tests` | Regression tests using real PG and actual Profiles |
| `scripts` | Local configuration and process management |

All product packages are private. The root Host TypeScript build includes product code. `pnpm run test:power-evolve` runs this slice's integration tests; the upstream default test command remains responsible for native packages. Product plugins use public services from the selected baseline without changing the Agent loop or native Session format.

Recorded conversations live in the [PowerEvolve snapshot](../../../snapshots/power-evolve/conversation/snapshot.yml). Product tests use its user input and assistant response and compare the complete Session event by event. This Profile requires real PG and runs through the product test command; the four native `test:snapshot` Profile adapters do not own it.
