# Bundled Skill release assets

English | [中文](README.zh.md)

These nine Skill packages come from the PowerEvolve built-in catalog. PDF retains its imported release; the Office and report packages use product catalog versions. Their `SOURCE.json`, where included, records the imported source and local adaptations. Office instructions use direct file operations and the [execution image configuration](../../../deploy/README.md); the report writers include explicit English metadata and Linux catalog refresh support.

Generate the 19 current distribution files in `generated-cloud-v2` with `node products/power-evolve/application/assets/builtin-skills/build-catalog.mjs`. The generator owns package versions; [the platform catalog loader](../../src/platform/builtin-skills.ts) pins the generated catalog digest. A changed package receives a new version. The generator refuses different bytes at an existing release path. Imported `generated` and earlier catalog generations remain intact. Installed historical bytes and accepted task receipts remain in persistent Skill storage when the distributed catalog advances.

The PDF source retains `pdf/SOURCE.json` and its Apache-2.0 `pdf/LICENSE.txt` in both source and ZIP. Other source directories are retained alongside the distribution ZIPs so the published bytes can be regenerated and reviewed.

The `extractSkillPackage` and `readNativeSkillMetadata` validators accept all nine ZIPs within the 1 MiB compressed, 256 file, 8 MiB expanded, and 256 KiB package `SKILL.md` limits. The platform installs private, versioned packages through its built-in catalog. Task grants carry Skill metadata; instructions and resources are read on demand without creating a Sandbox. Executable package resources run in the authorized execution image. [Application configuration](../../README.md) owns library limits, authorization, and version selection.

All nine current releases declare only the `cloud` target. Office uses the authorized cloud `office` tool; report scripts and LibreOffice/Poppler rendering use `cloud_exec` in the editable file’s `/workspace`. The catalog loader rejects other target lists and release/manifest disagreements. Existing private installations retain their pinned versions; preset reconciliation neither upgrades them nor revives revoked packages. Explicit installation of a verified successor retains historical package bytes and accepted task receipts.
