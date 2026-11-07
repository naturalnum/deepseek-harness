---
name: deepscientist-compute
description: Router for scientific compute setup, package environments, notebooks, LaTeX compilation, model endpoints, GPU/HPC/SSH/Modal workflows, and remote execution decisions in Science Mode.
---

# DeepScientist Compute Router

Use this skill when the task needs environment setup, dependency checks,
package installation strategy, notebook/runtime state, LaTeX compilation,
remote compute, SSH, Slurm/HPC, GPU runs, Modal, or managed model endpoints.

## Merge Map

- General compute discipline: `ds-science`, `ds-experiment`,
  `ds-analysis-campaign`.
- Environment and endpoints: JimLiu `compute-env-setup`,
  `managed-model-endpoints`, `using-model-endpoint`.
- Remote compute: JimLiu `remote-compute-ssh`, `remote-compute-modal`;
  K-Dense `kdense-modal`, `kdense-optimize-for-gpu`, `kdense-dask`,
  `kdense-nextflow`, `kdense-latchbio-integration`,
  `kdense-dnanexus-integration`.
- Local scientific packages: use the relevant domain router first, then package
  leaf skills only when they match the runtime.
- LaTeX: use the normal LaTeX bridge/runtime; record source, command, log,
  output PDF, and environment as artifact evidence.

## SOP

1. Check the project environment before installing or assuming packages.
2. Prefer existing project scripts, lockfiles, notebooks, and pipelines.
3. Ask before using new remote hosts, paid services, credentials, or large GPU
   jobs.
4. Record commands, cwd, env, package versions, job ids, logs, outputs, and
   failures as evidence.
5. Snapshot reproducibility files after successful or informative failed runs.

## Execution lanes

Choose the smallest lane that matches the user's request:

- **Validation lane (default for SSH/HPC/environment checks):** run one
  grouped, non-interactive preflight for connection, identity, working
  directory, and the requested runtime/GPU check. Reuse the same job or
  container, avoid repeated probes, and report the verified facts before
  stopping. Do not create a Team run, evidence search, Science report, visual,
  Git checkpoint, or artifact publication unless the user explicitly asks for
  parallel work or a durable deliverable.
- **Research lane:** when the user asks for scientific analysis, an experiment,
  or a reproducible deliverable, follow the normal Science workflow and record
  only the commands, outputs, and checkpoints needed to reproduce the result.
- **Interactive lane:** use `-tt`, `srun --pty`, or an interactive shell only
  when the user explicitly requests live shell control. Otherwise prefer
  bounded commands that can be logged and resumed.

Authentication or transport failures may be retried once with the same safe
parameters. Permission, contract, or missing-capability errors should be
reported instead of retried blindly.

## Boundaries

This router does not grant remote/HPC permission. It only chooses the safest
execution route and the evidence required to defend it.
