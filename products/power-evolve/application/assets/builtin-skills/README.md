# Bundled Skill release assets

English | [中文](README.zh.md)

These nine Skill packages come from the PowerEvolve built-in catalog. PDF, the power-grid report writer, the report reviewer, and the workflow orchestrator retain their imported releases. Word, Excel, PowerPoint, LaTeX report writer, and Word technical report writer have product releases whose `SOURCE.json` records the imported source and local adaptations. Office instructions use direct file operations and the [Sandbox document toolchain](../../../sandbox/README.md); the report writers include explicit English metadata and Linux catalog refresh support.

Regenerate the 19 distribution files with `node products/power-evolve/application/assets/builtin-skills/build-catalog.mjs`. The generator owns package versions; [the platform catalog loader](../../src/platform/builtin-skills.ts) pins the generated catalog digest. A changed package receives a new version. Installed historical bytes and accepted task receipts remain in persistent Skill storage when the distributed catalog advances.

The PDF source retains `pdf/SOURCE.json` and its Apache-2.0 `pdf/LICENSE.txt` in both source and ZIP. Other source directories are retained alongside the distribution ZIPs so the published bytes can be regenerated and reviewed.

The `extractSkillPackage` and `readNativeSkillMetadata` validators accept all nine ZIPs within the 1 MiB compressed, 256 file, 8 MiB expanded, and 256 KiB package `SKILL.md` limits. The platform installs private, versioned packages through its built-in catalog. Task grants carry Skill metadata; instructions and resources are read on demand without creating a Sandbox. Executable package resources run in the authorized Sandbox. [Application configuration](../../README.md) owns library limits, authorization, and version selection.
