# PowerEvolve upstream sync changes

English | [中文](CHANGES.zh.md)

This note describes the current source changes. Installation in a fresh environment, smoke9, and continuation of an existing Session remain required acceptance steps.

- A cold account restores its saved enabled MCP connections before the first model step captures its tools. Opening the MCP settings page first is unnecessary. Independent accounts keep their own tools and credentials.
- Cloud-admitted Node streams display fixed public text for generic internal failures. Server paths and private diagnostic text stay out of those error frames. Other Remote error codes keep their original messages; the original transport owns cleanup.
- PowerEvolve branding, icons, running text, new-session entry, plugin/skill pages, and account-owned model/search-key management remain part of the product.

The sync withdraws unused Native helpers and marker errors that claimed additional certification of host read cancellation and physical handle closure. Their fork-only tests retire with those helpers. Session reading follows the Native implementation; account authorization, output checks and actual write responsibility remain Cloud responsibilities. Retired requirements are not recorded as passing tests.

The Native Session format constant is **4** and the Native SQLite schema constant is **1**, unchanged between the previous comparison baseline and the selected Native release. This sync adds no further version increment. An unchanged version constant does not establish that an existing Session has passed real continuation testing.

The source ledger is [ledger.tsv](ledger.tsv); the generated interface inventory is [SEAMS.md](SEAMS.md).

等您回来看的事：目前技能名额只做了过渡：每个账号只有两个工作区能挂技能，第三个工作区可以执行命令但不能用技能；释放闲置工作区占用名额的真正回收还没做。
