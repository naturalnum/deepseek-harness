# PowerEvolve product development

This subtree owns PowerEvolve applications and adapters over the upstream Harness. Read [the product architecture](ARCHITECTURE.md) before changing service ownership, persistence, authorization, or execution placement.

- Launch the application host and trusted platform as separate `dsh` profiles. Product bundles explicitly select their plugins; cloud profiles never inherit an unrestricted local execution profile.
- The platform owns PostgreSQL, identity, resource authorization, durable operations, and provider credentials. The host uses bounded platform APIs and per-operation execution grants; it does not receive a database URL or provider API key.
- Keep the original DSH Session log and Inbox semantics. Persist acceptance before acknowledging an input; fence every runtime write with its current lease. Treat uncertain effects as reconciliation work.
- Implement complete user-visible slices with real composition, real PostgreSQL, authorization denial, idempotency, and applicable recovery checks. Record real-model evidence separately from deterministic tests.
- Keep product packages private under `@power-evolve`. Product code is outside upstream release membership; root build/type checks and product test commands must cover it.
- Product UI text belongs to a locale dictionary. Do not log credentials, bearer tokens, provider request bodies, or private user messages.
- The product browser uses the native DSH Web shell and product client plugins. `application/web` is a temporary slice test interface; do not add product pages there. Adapt the existing PowerEvolve Skills and Plugins client pages only after the native cloud conversation, files, execution, and desktop flows are working.
- Deliver a reproducible trial with its own database, private configuration, ports, and stable revision. Preserve other running products and their data.
- Keep exact tested commits in `baseline.json`, `TRIAL*.md`, `deploy/QA-*.md`, and `PARITY-AUDIT.md`. These evidence records are commit-reference exceptions in `verify-repository-references`; living architecture, README files, and executable sources still use release tags or configurable image references.
