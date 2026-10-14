import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'lib/types/index.js', protocol: 'lib/types/protocol.js', schemas: 'lib/types/schemas.js', helper: 'lib/types/helper-entry.js', 'helper-runtime': 'lib/types/helper-runtime.js' },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
