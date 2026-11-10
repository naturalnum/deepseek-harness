# DeepScientist and Airalogy for DeepSeek Harness

English | [中文](README.zh.md)

This plugin adds a research preset, tools, skills and a workbench to a Harness web profile. It targets the official `@deepseek-ai/dsh@0.2.1-rc.2` runtime. Source repositories and revisions are recorded in [source-lock.json](source-records/source-lock.json).

- **DeepScientist** adds the **科学研究 · DeepScientist** preset. Use it to search the literature, manage research tasks, inspect artifacts and generate reports within the current conversation. Online search and model access require their respective services.
- **Airalogy** provides AIMD protocols, research records and workflow executors. The workbench accepts CSV data, computes results and charts, and imports and exports `.aira` archives. It scopes uploads, approvals and changes to the current research conversation.

CSV import uses the selected task's method and table. Changing tasks resets the table choice; import stays unavailable while a different method loads. Late replies from a replaced method request cannot change the current table.

## Use the Cloud account integration

The independent Cloud adapter and deployment requirements are documented in [Cloud integration](CLOUD.md). Cloud mode keeps this package and its three research, Airalogy and workbench plugins, and reuses the existing account login, native Sessions, sidebar, files and managed execution. It does not start the local research HTTP server or accept its global tokens.

Retrying an already confirmed record submission with the same request ID and exact submitted parameters returns its original saved result in the same account and research conversation, without another submission or approval. A changed request conflicts; a new request for an old revision is rejected. If no completed result exists, including after a declined question, submission still requires the original native human confirmation. The default research tool catalog includes `research_record_submit_result` for this read-only lookup; it cannot approve or submit a record.

## Run locally

Install Node.js 24.14 or newer and make npm and pnpm available on PATH. For a dedicated Harness home and research data directory, set `DS_SUITE_HOME` and `DS_RESEARCH_DATA_DIR` before installation and use the same settings at launch. From the repository root, run the following commands.

```sh
cd integrations/epri-research
npm run install:suite
npm run start:all
```

The installer fetches the locked dependencies from npm, builds and tests the plugin and registers it in the dedicated `research-suite` profile. Open the Harness address printed by the launcher, sign in with your Harness account, and choose **科学研究 · DeepScientist**. Open the research workbench in the right sidebar of the current conversation. The default Harness port is 43128 and the research service uses 43127. Keep generated access URLs and local data private.

## Configure Airalogy execution

The frontend uses `@airalogy/aimd-core@2.15.0`. The included protocol and workflow executors come from the Apache-2.0 Airalogy engine 0.0.9 sources. The local service passes approved source packages to these executors to parse protocols, assign and validate variables, and run workflows. Research records use the Airalogy Record v1 schema.

For Docker execution, pull the pinned engine image. To enable document processing and OCR in Docker, also build the document image. Run both commands in the plugin directory.

```sh
docker pull ghcr.io/airalogy/airalogy-engine@sha256:5d26af0a28fc42f042cf079ac6e00b1a4435ff2d1fd02631c5d356bfdd0e08b7
docker build -f Dockerfile.documents -t epri-document-tools:20261026 .
```

For native computation on Windows, set `DS_NATIVE_PYTHON` to the absolute path of a Python 3.13 interpreter with `airalogy==0.16.0` installed. Native OCR also requires PyMuPDF 1.26.7, RapidOCR 3.10.0, ONNX Runtime 1.31.1 and the configured Chinese and English models. Native methods run with the current user's permissions. Select reviewed methods or use Docker for filesystem and network isolation.

## Verify the workbench

With services running, use `npm run doctor` to check component availability. Run `npm test` for service, persistence and authorization checks, and `npm run test:profile` for installation, preset composition and removal using the locked official CLI in an isolated home. Once the chosen execution backend is available, run `npm run test:engine` for protocol and workflow execution, variable assignments, CSV calculations and evidence records.

For a manual check, select the linear calibration method. Enter reference values `0, 1, 2` and measured values `1, 3, 5`. Verify a slope of `2` and an intercept of `1`. Export the research task as a `.aira` archive, import it into a new conversation and verify the task and calculated values.

## Register in an existing profile

Copy this directory into the target host branch. From the plugin directory run `npm ci`, `npm ci --prefix harness-runtime`, `npm run build` and `npm test`. From the intended Harness home, run `dsh plugin --profile YOUR_PROFILE add /absolute/path/to/integrations/epri-research`. In the plugin directory, run `npm start` to start the research backend and launch your profile with the same `DS_RESEARCH_DATA_DIR`. To remove the plugin, run `dsh plugin --profile YOUR_PROFILE remove deepscientist-harness-suite`.

When updating the host, check `engines.dsh` in `package.json` and retest the profile, workbench and Airalogy execution. Distribute the source with [LICENSE](LICENSE), [NOTICE](NOTICE) and the third-party licenses in `licenses/`.
