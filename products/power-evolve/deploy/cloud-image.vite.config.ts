/** Build the official served Web shell without its separately excluded worker-preview entry. */
import upstream from '../../../apps/web/vite.config.ts'

export default {
  ...upstream,
  plugins: upstream.plugins?.filter(plugin => !(plugin && !Array.isArray(plugin) && typeof plugin === 'object'
    && 'name' in plugin && plugin.name === 'dsh-emit-preview-page')),
  build: {
    ...upstream.build,
    rollupOptions: {
      ...upstream.build?.rollupOptions,
      input: { index: new URL('../../../apps/web/index.html', import.meta.url).pathname },
    },
  },
}
