---
kind: upgrade-guide
description: Managed skill details require root instructions in strict Remote replies.
---

# Managed skill instructions

English | [中文](guide.zh.md)

## Change

`cloudSkills/details` returns the complete root `SKILL.md` in a required `markdown` field alongside installed metadata. Previous strict result codecs reject the additional field, and the new codec rejects replies without it. The Skills dialog reads this text through the current account and downloads the complete immutable package through the existing download operation.

## Migration

1. Build and deploy `pe-cloud-api` and its generated `pe-cloud-client` contribution together. Do not mix old and new strict Remote descriptors.
2. Update custom `ManagedSkillDetails` providers and test replies to include the actual root instructions as `markdown`. Retain the account guard, immutable-version borrow and complete serialized reply limit.
3. Refresh the browser and open an installed skill. Confirm that its instructions render and Download returns the installed package with its resources.
