import { defineConfig } from 'tsdown'

const id = '@power-evolve/client-cloud-workspaces'
const protocol = /^@power-evolve\/contracts(?:\/|$)/u
const browserZodConfig = 'globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;'

export default defineConfig([
  { name: id, entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024', clean: false, dts: false },
  {
    name: `${id}/client`, entry: { client: 'src/client/index.ts' }, outDir: 'lib', format: 'cjs',
    platform: 'browser', target: 'es2022', clean: false, dts: false,
    deps: {
      alwaysBundle: [protocol, /^zod(?:\/|$)/u, '@deepseek-ai/dsh-brand'],
      onlyBundle: ['zod'],
      neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-store',
        '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: `var module = { exports: {} }; var exports = module.exports; ${browserZodConfig}`,
    },
  },
])
