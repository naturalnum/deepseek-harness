import { defineConfig } from 'tsdown'
import { copyFile, readdir, writeFile } from 'node:fs/promises'

const id = '@power-evolve/client-account'
const protocol = /^@power-evolve\/contracts(?:\/|$)/u
// Set Zod's supported pre-import flag before schemas initialize under the page CSP.
const browserZodConfig = 'globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;'

export default defineConfig([
  { name: id, entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024', clean: false, dts: false },
  {
    name: `${id}/client`, entry: { client: 'src/client/index.ts' }, outDir: 'lib', format: 'cjs',
    platform: 'browser', target: 'es2022', clean: false, dts: false,
    deps: { alwaysBundle: [protocol, /^zod(?:\/|$)/u, '@deepseek-ai/dsh-brand'],
      onlyBundle: ['zod'],
      neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: `var module = { exports: {} }; var exports = module.exports; ${browserZodConfig}`,
    },
  },
  {
    name: `${id}/trusted`, entry: { account: 'src/trusted/main.tsx' }, outDir: 'lib/trusted', format: 'esm',
    platform: 'browser', target: 'es2022', clean: true, dts: false, sourcemap: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    deps: { alwaysBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      protocol, /^zod(?:\/|$)/u, '@deepseek-ai/dsh-brand'],
      onlyBundle: ['react', 'react-dom', 'scheduler', 'zod'] },
    outputOptions: { banner: browserZodConfig },
    onSuccess: async () => {
      const directory = new URL('./lib/trusted/', import.meta.url)
      await copyFile(new URL('./src/trusted/index.html', import.meta.url), new URL('index.html', directory))
      await copyFile(new URL('./src/trusted/account.css', import.meta.url), new URL('account.css', directory))
      const entries = await readdir(directory, { withFileTypes: true })
      const files = entries.filter(entry => entry.isFile() && /\.(?:html|js|css|woff2?|svg|png)$/u.test(entry.name))
        .map(entry => entry.name).sort()
      await writeFile(new URL('asset-list.json', directory), `${JSON.stringify(files)}\n`)
    },
  },
])
