/** Official V8 instrumentation with native maps merged before reports and strict thresholds. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import v8 from '@vitest/coverage-v8'
import { convertNativeCoverage } from './cloud-coverage.mjs'
import { cloudScope } from './cloud-scope.mjs'

/** Extend the locked V8 provider's map generation; retain its report and threshold implementations.
 * @returns Official V8 provider with native source-level coverage merged exactly once.
 */
export async function createCloudCoverageProvider() {
  const inputPath = process.env.PE_CLOUD_COVERAGE_INPUT
  if (!inputPath) throw new Error('Cloud coverage provider requires native execution inputs')
  const input = JSON.parse(readFileSync(inputPath, 'utf8'))
  if (input.scope) {
    const scope = cloudScope(input.root)
    if (input.scope.selection !== scope.selection || input.scope.manifest !== scope.manifestPath
      || JSON.stringify(input.runtime) !== JSON.stringify(scope.corpus.runtime)
      || JSON.stringify(input.tests) !== JSON.stringify(scope.corpus.nodeTests)) {
      throw new Error('Cloud coverage provider: native and Vitest named scopes differ')
    }
  }
  const provider = await v8.getProvider()
  const original = provider.generateCoverage.bind(provider)
  provider.generateCoverage = async (context) => {
    const map = await original(context)
    const directory = provider.options.reportsDirectory
    mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, 'coverage-vitest.json'), JSON.stringify(map.toJSON()))
    const native = await convertNativeCoverage(inputPath)
    map.merge(native.map)
    writeFileSync(resolve(directory, 'native-coverage.json'), JSON.stringify(native.facts, null, 2))
    return map
  }
  return provider
}

/** V8's native hooks with source-level merging in the provider generation phase. */
export default { ...v8, getProvider: createCloudCoverageProvider }
