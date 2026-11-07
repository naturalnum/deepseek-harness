// Customer edition: power engineering and general research. Preserve upstream
// sources for inspection, but do not register specialist life-science skills.
export const excludedSkills = new Set(`
biomodels singlecell deepscientist-bio deepscientist-target-discovery
openai4s-alphafold2 openai4s-boltz openai4s-scgpt
kdense-adaptyv kdense-anndata kdense-arboreto kdense-benchling-integration
kdense-bids kdense-biopython kdense-bioservices kdense-bulk-rnaseq
kdense-cellxgene-census kdense-clinical-decision-support kdense-clinical-reports
kdense-cobrapy kdense-datamol kdense-deepchem kdense-deeptools kdense-depmap
kdense-diffdock kdense-dnanexus-integration kdense-esm kdense-etetoolkit
kdense-flowio kdense-geniml kdense-gget kdense-ginkgo-cloud-lab
kdense-glycoengineering kdense-gtars kdense-histolab kdense-imaging-data-commons
kdense-iso-13485-certification kdense-lamindb kdense-latchbio-integration
kdense-matchms kdense-medchem kdense-molecular-dynamics kdense-molfeat
kdense-neurokit2 kdense-neuropixels-analysis kdense-nextflow kdense-omero-integration
kdense-onekgpd kdense-opentrons-integration kdense-pacsomatic kdense-pathml
kdense-pathway-enrichment kdense-phylogenetics kdense-polars-bio kdense-primekg
kdense-pydeseq2 kdense-pydicom kdense-pyhealth kdense-pylabrobot
kdense-pyopenms kdense-pysam kdense-pytdc kdense-rdkit kdense-rowan
kdense-scanpy kdense-scikit-bio kdense-scvelo kdense-scvi-tools
kdense-tamarind kdense-tiledbvcf kdense-torchdrug kdense-treatment-plans
`.trim().split(/\s+/));

// These upstream routers are superseded by the installed Harness adapters.
const replacedRouters = new Set(['science', 'databases', 'deepscientist-protocol-workflow']);
export const customerSkillEnabled = folder => !excludedSkills.has(folder) && !replacedRouters.has(folder);
