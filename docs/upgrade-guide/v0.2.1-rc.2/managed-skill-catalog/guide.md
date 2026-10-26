---
kind: upgrade-guide
description: "Managed skill catalogs and full-tree copy records require readers that understand schema2."
---
# Managed skill catalog readers require schema2 support

English | [中文](guide.zh.md)

## Change

Enabling `pe-cloud-files/root.skillBundles` writes managed installations to the existing private `skills/current.json` as a schema2 catalog. Schema1 is read without migration as the legacy `sample` installation; the first catalog commit preserves that entry and its immutable versions. Legacy APIs still publish exactly two files in that slot. Full-tree project-copy associations use schema2 alongside supported legacy schema1 records. Older readers reject the new formats and cannot safely manage those directories.

## Migration

1. Upgrade the files helper, files package and consuming native provider/API together. Configure every `skillBundles` limit explicitly inside the existing qualified private/projects hard domains. Require all three independent bundle helper capabilities; ABI8 alone is insufficient.
2. Route management edits through the same AccountSaves turn and complete catalog FsVersion CAS. Full-tree native consumers retain the original operation borrow; materialization inside `withBundleSource` uses its `source.version` lease.
3. Confirm both legacy sample content and a second installation with nested resources survive listing, update and complete download. An old catalog token must conflict. After uninstall, new loads must fail while existing working copies remain available.
4. Retain supported readers after the first schema2 write. Do not edit or replace `skills/current.json` to downgrade. Preserve user copies and immutable source dependencies during recovery; unknown effects need the original owner to resolve them before reuse.
