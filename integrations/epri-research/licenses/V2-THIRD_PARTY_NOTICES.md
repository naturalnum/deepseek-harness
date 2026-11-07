# Third-Party Notices

This file records important upstream and third-party notices for the DeepScientist distribution. It is not a full legal audit. Before a public or commercial release, review all dependencies, vendored resources, generated assets, and data connectors again.

## Upstream Desktop Foundation

| Component                    | Source                                                   | License    | Notice                                          |
| ---------------------------- | -------------------------------------------------------- | ---------- | ----------------------------------------------- |
| AionUi                       | <https://github.com/iOfficeAI/AionUi>                    | Apache-2.0 | Copyright 2025 AionUi (aionui.com)              |
| DeepScientist lineage notice | Preserved from this repository's previous root `LICENSE` | Apache-2.0 | Copyright 2025 DeepScientist (deepscientist.cc) |

DeepScientist is a modified work based on AionUi. Starting from this fork/distribution, DeepScientist is distributed under AGPL-3.0-only, except for third-party components and files that carry separate license notices. The original Apache-2.0 license text is preserved in `LICENSES/Apache-2.0.txt`.

## Modification Statement

Major DeepScientist changes include rebranding, Science Mode planning, research-project workflows, Medical Evidence Mode, evidence-labeled report surfaces, scientific artifact preview concepts, localized README files, generated brand assets, local MCP/tooling plans, and research workflow integrations.

Representative modified or added areas include:

| Path                                                 | Modification type                                            |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `readme.md`                                          | DeepScientist README, product positioning, license notice    |
| `docs/readme/`                                       | Localized DeepScientist README files                         |
| `docs/specs/science-mode-architecture.zh-CN.md`      | Science Mode architecture and checklist                      |
| `resources/readme/`                                  | README product screenshots and diagrams                      |
| `resources/deepscientist-logo.*`                     | DeepScientist brand assets                                   |
| `packages/desktop/src/common/chat/`                  | Research, evidence, and science-mode chat configuration work |
| `packages/desktop/src/common/config/`                | Research/evidence configuration work                         |
| `packages/desktop/src/process/resources/builtinMcp/` | Built-in MCP server integrations                             |
| `packages/desktop/src/renderer/pages/conversation/`  | Conversation, preview, evidence, and artifact UI work        |
| `packages/desktop/src/renderer/pages/settings/`      | Settings UI for research/evidence features                   |

For the exact file-level history, compare this fork against the relevant upstream AionUi revision and inspect the git history of this repository.

## IOAI Competition Engine Migration

`packages/ioai-competition-engine/` contains behavior-preserving migrations from the local DeepScientist v1.6 IOAI competition refactor. The selected migration source is recorded by a content-addressed manifest and golden fixtures in that package. The migrated v1.6 source is Apache-2.0; the license text is preserved in `LICENSES/Apache-2.0.txt`. V2-specific integration code remains governed by this repository's root license unless a file states otherwise.

The public shadow-run fixture under `packages/ioai-competition-engine/src/deepscientist_ioai_engine/contest/public_ioai_2025_antique/` contains the IOAI 2025 Individual Contest task "Antique Painting Authentication" notebook, public `training_set.csv`, and upstream license from <https://github.com/IOAI-official/IOAI-2025> at commit `39558e9a639d170bd92de91958fcdc915f670463`. These files are licensed under CC BY 4.0. DeepScientist excludes the upstream solution, validation/test sets, scoring labels, submissions, and score output; its two-case shadow holdout is derived only from public training labels and is not an official IOAI leaderboard result.

## Runtime Dependencies

The root `package.json` uses third-party npm packages under their own licenses. A quick local package metadata scan found mostly MIT dependencies, plus Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, and one dependency package with unspecified metadata. Each package remains governed by its own license.

Important examples include:

| Package family                 | License metadata seen locally                             |
| ------------------------------ | --------------------------------------------------------- |
| React, many frontend utilities | MIT                                                       |
| Model and protocol SDKs        | Apache-2.0 or vendor-specific terms, depending on package |
| Build and Electron tooling     | MIT, Apache-2.0, ISC, BSD variants                        |
| OGL                            | MIT                                                       |
| React Diff View                | MIT, Copyright (c) 2017 Gray Zhang                        |

Do not treat this table as a complete dependency clearance report. Regenerate a dependency license report before publishing release artifacts.

React Diff View is used to render selectable Git diffs in the research progress viewer. Source: <https://github.com/otakustay/react-diff-view>.

Thinking Orbs is used for compact, state-specific activity indicators in conversation and verification surfaces.

- Source: <https://github.com/Jakubantalik/thinking-orbs>
- License: MIT
- Copyright (c) 2026 Jakub Antalik
- DeepScientist integration: the upstream package is consumed through a local semantic wrapper that maps existing runtime events to visual states, keeps the canvas non-interactive, and preserves static terminal outcomes.

React Bits Side Rays notice:

- Source: <https://www.reactbits.dev/backgrounds/side-rays>
- License: MIT + Commons Clause License Condition v1.0
- Copyright (c) 2026 David Haz
- Changes made in DeepScientist: feature-scoped OGL loading, semantic theme colors, a 30 FPS frame cap, reduced-motion and visibility pausing, WebGL failure fallback, and a monochrome DeepScientist composition.
- The adapted component is distributed only as part of this application and is not offered for resale or redistribution as a standalone component.

## Vendored Research Skills And Resources

This repository includes or may include vendored research skills under `resources/skills/vendor/`. These resources are especially mixed and should be treated as optional third-party material until reviewed.

Observed license metadata includes:

| Vendor area                                               | License notes                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources/skills/vendor/deepscientist-1.6.0/`            | Apache-2.0 project metadata; bundled dependencies and templates require their own review                                                                                                                                                                                          |
| `resources/skills/vendor/scientific-agent-skills/`        | Repository-level MIT license, but individual skills declare different licenses                                                                                                                                                                                                    |
| `resources/skills/vendor/auto-empirical-research-skills/` | CC-BY-SA-4.0, Copyright (c) 2026 CoPaper.AI                                                                                                                                                                                                                                       |
| `resources/skills/ds-idea/`                               | Adapted from Microsoft ResearchStudio-Idea `idea_spark`, MIT license, Copyright (c) 2026 Happy                                                                                                                                                                                    |
| Individual scientific-agent skills                        | MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, GPL-2.0, GPL-3.0, CeCILL, CC-BY, CC-BY-NC/CC-BY-NC-SA, Proprietary, Unknown, and unspecified metadata appear in local skill files                                                                                                    |
| Materialized DeepScientist `aer-*` skills                 | Adapted from Auto-Empirical Research Skills. DeepScientist changes include normalized frontmatter, first-class skill ids, adapter SOP text, provenance/risk metadata, and a generated manifest. These adapted skill contents are distributed under CC-BY-SA-4.0 ShareAlike terms. |

Some skill files mention proprietary services, proprietary file formats, non-commercial datasets, commercial database access, or API-key-gated services. Users and redistributors must check the license and terms for each skill, database, dataset, connector, and service before enabling it in a release or commercial environment.

Auto-Empirical Research Skills license notice:

- Creative Commons Attribution-ShareAlike 4.0 International
- Copyright (c) 2026 CoPaper.AI
- Full license text: <https://creativecommons.org/licenses/by-sa/4.0/legalcode>
- Source repository: <https://github.com/brycewang-stanford/Auto-Empirical-Research-Skills>
- Changes made in DeepScientist: curated materialization into `resources/skills/aer-*`, DeepScientist Adapter instructions, generated source/provenance metadata, execution-policy classification, and settings/report integration.

Microsoft ResearchStudio-Idea notice:

- MIT License
- Copyright (c) 2026 Happy
- Source repository: <https://github.com/microsoft/ResearchStudio/tree/main/ResearchStudio-Idea>
- Changes made in DeepScientist: retained the upstream IdeaSpark references/scripts as optional paper-ideation material, replaced the default `ds-idea` workflow with the native evidence-first DeepScientist Idea stage, and explicitly bypassed IdeaSpark, broad Paper Search, novelty review, and rendering on the IOAI competition fast path.

## Generated And External Assets

Generated images, icons, and README screenshots in this repository are DeepScientist project assets unless a file states otherwise. External logos, screenshots, upstream marks, and service names remain the property of their respective owners.

## No Upstream Endorsement

The presence of an upstream notice does not imply endorsement. AionUi, iOfficeAI, DeepScientist, DeepScientist, and any third-party project or vendor named here do not endorse DeepScientist unless expressly stated.
