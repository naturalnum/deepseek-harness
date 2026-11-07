/** Isolated Cloud-suite component tests use the repository's original Host source resolver. */
import {defineConfig} from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import {standardDecoratorPlugin} from '../../vitest.shared.ts'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
export default defineConfig({plugins:[{name:'suite-text-assets',load(id){if(/\.(aimd|toml|py)$/u.test(id))return 'export default '+JSON.stringify(readFileSync(id,'utf8'))}},tsconfigPaths({projects:['./tsconfig.base.json']}),standardDecoratorPlugin()],
  resolve:{alias:{'@/common/chat/reportChart':fileURLToPath(new URL('./src/reused/common/reportChart.ts',import.meta.url)),
    '@/common/chat/reportChartScene':fileURLToPath(new URL('./src/reused/common/reportChartScene.ts',import.meta.url))}},
  test:{include:['integrations/epri-research/tests/cloud-*.spec.ts'],maxWorkers:1,testTimeout:15000}})
