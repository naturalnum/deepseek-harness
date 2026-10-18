/** Vite adapters for recording product chunk, asset, CSS, and worker inputs. */

import type { Plugin } from 'vite'
import { WebProductBundleIsolation } from '../../scripts/web-product-bundle-isolation.ts'

const DEPENDENCY_ANALYSIS_PLUGIN = 'dsh-browser-dependency-analysis'

/**
 * Identify a dependency-disclosure walk that deliberately leaves third-party imports external.
 * @returns Analysis intent that refuses builds which can write output.
 */
export function browserDependencyAnalysis(): Plugin {
  return {
    name: DEPENDENCY_ANALYSIS_PLUGIN,
    apply: 'build',
    configResolved(config) { requireNonWritingAnalysis(config.build.write) },
  }
}

function requireNonWritingAnalysis(write: boolean): void {
  if (write !== false) throw new Error('browser dependency analysis requires build.write: false')
}

function watchContext<T extends { addWatchFile(file: string): void }>(context: T, record: (file: string) => void): T {
  return new Proxy(context, {
    get(target, property) {
      if (property === 'addWatchFile') return (file: string): void => {
        record(file)
        target.addWatchFile(file)
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function instrumentWorkerFiles(plugins: readonly Plugin[], inputs: WebProductBundleIsolation): void {
  const workers = plugins.filter(plugin => plugin.name === 'vite:worker')
  const urls = plugins.filter(plugin => plugin.name === 'vite:worker-import-meta-url')
  const worker = workers[0], url = urls[0]
  if (workers.length !== 1 || urls.length !== 1 || worker?.load === undefined
    || worker.transform === undefined || url?.transform === undefined) {
    throw new Error('Web product isolation: Vite worker input instrumentation is unavailable')
  }
  const load = typeof worker.load === 'function' ? worker.load : worker.load.handler
  worker.load = {
    ...typeof worker.load === 'function' ? {} : worker.load,
    handler(id, options) {
      inputs.moduleFileTransform(id, 'worker-load')
      return load.call(watchContext(this, (file) => { inputs.moduleFileDependency(id, 'worker-load', file) }), id, options)
    },
  }
  for (const [plugin, original, hook] of [
    [worker, worker.transform, 'worker-transform'], [url, url.transform, 'worker-url'],
  ] as const) {
    const transform = typeof original === 'function' ? original : original.handler
    plugin.transform = {
      ...typeof original === 'function' ? {} : original,
      handler(code, id, options) {
        inputs.moduleFileTransform(id, hook)
        return transform.call(watchContext(this, (file) => { inputs.moduleFileDependency(id, hook, file) }), code, id, options)
      },
    }
  }
}

/**
 * Reject experimental inputs reachable from the built default Web page.
 * @param repository - repository root supplying package ownership.
 * @param webRoot - Vite root containing index.html and public assets.
 * @returns Build plugins that preserve Vite's output and fail before publication on a violation.
 */
export function productWebBundleIsolation(repository: string, webRoot: string): Plugin[] {
  const inputs = new WebProductBundleIsolation(repository, webRoot)
  let dependencyAnalysis = false
  return [{
    name: 'dsh-product-web-chunk-inputs',
    apply: 'build',
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        if (!dependencyAnalysis) inputs.captureChunks(bundle)
      },
    },
  }, {
    name: 'dsh-product-web-bundle-isolation',
    apply: 'build',
    enforce: 'post',
    config(config) {
      const renderBuiltUrl = config.experimental?.renderBuiltUrl
      const workerPlugins = config.worker?.plugins
      return {
        experimental: {
          renderBuiltUrl(filename, context) {
            inputs.assetReference(filename, context.hostId, context.type)
            return renderBuiltUrl?.(filename, context)
          },
        },
        worker: {
          plugins: () => [...workerPlugins?.() ?? [], {
            name: 'dsh-worker-build-inputs',
            generateBundle: {
              order: 'post',
              handler(_options, bundle) {
                const context: { getModuleIds(): IterableIterator<string>; getWatchFiles?(): string[] } = this
                const files = [...context.getModuleIds()]
                // Rollup exposes this on PluginContext; Rolldown forwards build.watchFiles through Vite instead.
                if (context.getWatchFiles !== undefined) files.push(...context.getWatchFiles())
                inputs.workerBundle(bundle, files)
              },
            },
          }],
        },
      }
    },
    configResolved(config) {
      dependencyAnalysis = config.plugins.some(plugin => plugin.name === DEPENDENCY_ANALYSIS_PLUGIN)
      if (dependencyAnalysis) {
        requireNonWritingAnalysis(config.build.write)
        return
      }
      instrumentWorkerFiles(config.plugins, inputs)
      const cssPlugins = config.plugins.filter(plugin => plugin.name === 'vite:css')
      const css = cssPlugins[0]
      if (cssPlugins.length !== 1 || css?.transform === undefined) {
        throw new Error('Web product isolation: Vite CSS input instrumentation is unavailable')
      }
      const transform = typeof css.transform === 'function' ? css.transform : css.transform.handler
      css.transform = {
        ...typeof css.transform === 'function' ? {} : css.transform,
        handler(code, id, options) {
          inputs.cssTransform(id)
          const context = watchContext(this, (file) => { inputs.cssDependency(id, file) })
          return transform.call(context, code, id, options)
        },
      }
    },
    buildStart() { inputs.reset() },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        if (!dependencyAnalysis) inputs.verify(bundle, id => this.getModuleInfo(id))
      },
    },
  }]
}
