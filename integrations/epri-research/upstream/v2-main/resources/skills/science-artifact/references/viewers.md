# Scientific Viewers

Read this file only when adding or updating an interactive scientific Viewer.
A Viewer helps inspect a saved artifact; it is not evidence by itself.

## General rules

- Put Viewer settings under `payload.viewer`.
- Use project-relative, durable paths. Do not save temporary local asset URLs.
- Save the data, indexes, configuration, hashes, commands, logs, and evidence
  needed to understand the display.
- Read the artifact before the first Viewer change and pass `baseRevision`.
  Reuse the returned revision for consecutive changes.
- Use `version` when the underlying scientific content changes. Use `patch`
  only when display settings change.
- If a required data, index, reference, or configuration file is missing, show
  a warning or mark the artifact blocked instead of displaying a misleading
  Viewer.

## Supported kinds

| Viewer                             | Typical artifact              | Required information                                                         |
| ---------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `3dmol`, `molstar`, `rcsb_molstar` | protein structure or molecule | coordinate path, format, source, parse check, optional focus and annotations |
| `igv`                              | genome track                  | genome or reference, locus, tracks, indexes, and file checks                 |
| `ketcher`                          | molecule                      | molecule path or initial SMILES, format, edit and save policy, parse check   |
| `vitessce`                         | dataset or run bundle         | configuration, data paths, conversion log, and validation result             |
| `msa`                              | alignment                     | alignment path, format, parse check, and selected sequence or region         |

Use the artifact type that matches the real file. Call `describe` when the exact
payload fields are unclear instead of copying an unrelated example.

## Structures and molecules

For a structure artifact, normally save:

- the coordinate file and format;
- the source record or uploaded-file source;
- a parse result with file hash, atom, residue, chain, ligand, and model counts;
- missing-residue, alternative-location, resolution, or confidence warnings
  when available; and
- the command, code, log, environment, and output when the structure was
  generated.

Use `type="protein_structure"` for proteins and `type="molecule"` for ligands
or generated poses. Common structure formats are PDB, CIF/mmCIF, and PQR;
common molecule formats are SDF, MOL, MOL2, and XYZ.

Viewer focus and annotations should identify real chains, residues, ligands, or
atoms and link to the evidence that supports their interpretation. Changing a
coordinate file or generated pose requires a new artifact version.

## Genome, single-cell, and alignment data

- IGV tracks must include their indexes and the matching genome or reference.
- Vitessce workspaces must keep the configuration and converted data paths
  together with the conversion log.
- Alignment Viewers must record the alignment format and a successful parse or
  format check.

Create a page only as a convenient way to open a concrete artifact. Unless the
user asks otherwise, keep the final report as the default published page.
