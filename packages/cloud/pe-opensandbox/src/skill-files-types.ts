/** Type aliases derived from the actual CloudAccountFiles methods; no value or authority is manufactured. */
import type { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
/** Exact parent value returned by the original files owner. */
export type SkillProjectGrant = Awaited<ReturnType<CloudAccountFiles['prepareSkillProject']>>['value']
/** Exact working copy returned after actual materialization. */
export type SkillWorkingCopyGrant = Awaited<ReturnType<CloudAccountFiles['materializeSkillVersion']>>['value']
/** Exact retained operation result from the original files owner. */
export type SkillOperationCopies = Awaited<ReturnType<CloudAccountFiles['borrowBundleWorkingCopies']>>['value']
