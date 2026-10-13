/** Product-owned source tests and per-file coverage, independent of Desktop and upstream release membership. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'
import { cloudScope } from './products/power-evolve/scripts/cloud-scope.mjs'

const corpus = cloudScope(import.meta.dirname).corpus

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: [
    { find: './dsh-util-crypto.js', replacement: resolve(import.meta.dirname, 'packages/util/crypto/src/index.ts') },
    { find: './execution-resolution-contract.js', replacement: resolve(import.meta.dirname, 'products/power-evolve/contracts/src/execution-resolution.ts') },
  ] },
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    include: corpus.vitestTests,
    // The serial cloud entry runs node:test sources in their native runner and merges their V8 coverage.
    exclude: [...corpus.nodeTests,
      '**/*.built.{spec,test}.{ts,tsx,js,mjs}', '**/node_modules/**', '**/lib/**', '**/dist/**'],
    pool: 'forks', execArgv: vitestExecArgv, testTimeout: 30_000, hookTimeout: 30_000,
    maxWorkers: 2,
    passWithNoTests: false,
    coverage: {
      ...(process.env.PE_CLOUD_COVERAGE_INPUT
        ? { provider: 'custom' as const, customProviderModule: './products/power-evolve/scripts/cloud-provider.mjs' }
        : { provider: 'v8' as const }),
      reportsDirectory: 'coverage/power-evolve-cloud', reporter: ['text', 'json', 'json-summary', 'lcov'],
      include: corpus.runtime,
      exclude: ['**/*.d.ts', '**/tests/**', '**/*.{spec,test}.{ts,tsx,js,mjs}'],
      thresholds: { perFile: true, lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
})
