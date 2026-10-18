/** Experimental-package isolation over Vite's emitted product graph and recorded file inputs. */

import { basename, resolve } from 'node:path'
import { BundleInputIsolation, physicalBundleInput } from './bundle-input-isolation.ts'

/** Exact generated helper ID exposed by Rolldown's public RUNTIME_MODULE_ID. */
const ROLLDOWN_RUNTIME_MODULE_ID = '\0rolldown/runtime.js'

/** The emitted chunk fields used to follow the product's actual output graph. */
export interface WebOutputChunk {
  type: 'chunk'
  fileName: string
  preliminaryFileName?: string
  facadeModuleId: string | null
  modules: Record<string, unknown>
  imports: string[]
  dynamicImports: string[]
  /** Rollup-only implicit chunk edges; absent from Rolldown's public OutputChunk. */
  implicitlyLoadedBefore?: string[]
  /** Rollup-only emitted-file edges; Vite URL and asset metadata are tracked independently. */
  referencedFiles?: string[]
  viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> }
}

/** Original file names provide ownership for emitted, non-CSS assets. */
export interface WebOutputAsset {
  type: 'asset'
  fileName: string
  names: string[]
  originalFileNames: string[]
}

/** Vite's output bundle, restricted to the fields needed by this check. */
export type WebOutputBundle = Record<string, WebOutputChunk | WebOutputAsset>

/** Retained source edges, including CSS modules whose pure output chunks Vite removes. */
export interface WebModuleInfo {
  importedIds: readonly string[]
  dynamicallyImportedIds: readonly string[]
  /** Rollup flags are absent from Rolldown's public ModuleInfo. */
  isExternal?: boolean
  isIncluded?: boolean | null
  /** At output time, Rolldown reports null code for external modules. */
  code?: string | null
}

interface AssetReference {
  host: string
  file: string
  type: 'asset' | 'public'
}

/** Output graphs are rebuilt each time; cached transforms retain their file-input observations. */
export class WebProductBundleIsolation {
  private readonly cssInputs = new Map<string, Set<string>>()
  private readonly moduleFiles = new Map<string, Map<string, Set<string>>>()
  private readonly chunks = new Map<string, WebOutputChunk>()
  private readonly references: AssetReference[] = []
  private readonly workerInputs = new Map<string, Set<string>>()
  private readonly inputs: BundleInputIsolation
  private readonly webRoot: string

  constructor(repository: string, webRoot: string) {
    this.webRoot = webRoot
    this.inputs = new BundleInputIsolation(repository, 'Web product isolation')
  }

  /** Discard output graphs and package metadata before a build or watch rebuild. */
  reset(): void {
    this.chunks.clear()
    this.references.length = 0
    this.workerInputs.clear()
    this.inputs.reset()
  }

  /** Replace dependency observations whenever Vite transforms a module again. */
  cssTransform(module: string): void { this.cssInputs.set(module, new Set<string>()) }

  /** Record the files the actual CSS transform asks Rollup to watch. */
  cssDependency(module: string, file: string): void {
    const inputs = this.cssInputs.get(module) ?? new Set<string>()
    inputs.add(file)
    this.cssInputs.set(module, inputs)
  }

  /**
   * Replace one Vite hook's file observations while retaining cached observations from other hooks.
   * @param module - Actual load or transform module ID.
   * @param hook - Stable recorder identity for that Vite hook.
   */
  moduleFileTransform(module: string, hook: string): void {
    const hooks = this.moduleFiles.get(module) ?? new Map<string, Set<string>>()
    hooks.set(hook, new Set<string>())
    this.moduleFiles.set(module, hooks)
  }

  /**
   * Record actual addWatchFile calls, including Vite's complete worker subbuild watch list.
   * @param module - Module whose Vite hook requested this file.
   * @param hook - Stable recorder identity for that Vite hook.
   * @param file - Original file passed to the build context's addWatchFile.
   */
  moduleFileDependency(module: string, hook: string, file: string): void {
    const hooks = this.moduleFiles.get(module) ?? new Map<string, Set<string>>()
    const files = hooks.get(hook) ?? new Set<string>()
    files.add(file)
    hooks.set(hook, files)
    this.moduleFiles.set(module, hooks)
  }

  /** Record Vite's asset URL edges without changing their rendered values. */
  assetReference(file: string, host: string, type: 'asset' | 'public'): void {
    this.references.push({ file, host, type })
  }

  /** Preserve pure CSS chunk inputs before Vite removes their JavaScript wrappers. */
  captureChunks(bundle: WebOutputBundle): void {
    for (const item of Object.values(bundle)) {
      if (item.type !== 'chunk') continue
      this.chunks.set(item.fileName, {
        ...item,
        modules: { ...item.modules },
        imports: [...item.imports],
        dynamicImports: [...item.dynamicImports],
        implicitlyLoadedBefore: item.implicitlyLoadedBefore === undefined ? [] : [...item.implicitlyLoadedBefore],
        referencedFiles: item.referencedFiles === undefined ? [] : [...item.referencedFiles],
        ...(item.viteMetadata === undefined ? {} : { viteMetadata: {
          importedCss: new Set(item.viteMetadata.importedCss),
          importedAssets: new Set(item.viteMetadata.importedAssets),
        } }),
      })
    }
  }

  /** Capture worker graph inputs; Vite also forwards its complete watch list to the calling module. */
  workerBundle(bundle: WebOutputBundle, watchedFiles: readonly string[]): void {
    const inputs = new Set(watchedFiles)
    const entries: string[] = []
    for (const item of Object.values(bundle)) {
      if (item.type === 'chunk') {
        for (const id of Object.keys(item.modules)) inputs.add(id)
        if (item.facadeModuleId !== null) entries.push(physicalBundleInput(item.facadeModuleId) ?? item.facadeModuleId)
      }
    }
    for (const file of [...Object.keys(bundle), ...entries]) {
      this.workerInputs.set(file, new Set([...this.workerInputs.get(file) ?? [], ...inputs]))
    }
  }

  /** Reject experimental ownership in everything the emitted index page can load. */
  verify(bundle: WebOutputBundle, moduleInfo: (id: string) => WebModuleInfo | null): void {
    const html = bundle['index.html']
    if (html?.type !== 'asset' || !html.originalFileNames.some(file =>
      resolve(this.webRoot, file) === resolve(this.webRoot, 'index.html'))) {
      throw new Error('Web product isolation: emitted index.html is missing its original HTML input')
    }
    const outputs = new Map(Object.entries(bundle))
    const aliases = new Map<string, string>()
    const cssOwners = new Map<string, Set<string>>()
    for (const [file, chunk] of this.chunks) {
      aliases.set(chunk.preliminaryFileName ?? file, file)
      for (const css of chunk.viteMetadata?.importedCss ?? []) {
        const owners = cssOwners.get(css) ?? new Set<string>()
        for (const id of Object.keys(chunk.modules)) owners.add(id)
        cssOwners.set(css, owners)
      }
    }
    for (const item of Object.values(bundle)) {
      if (item.type === 'asset') {
        for (const name of item.names) aliases.set(name, item.fileName)
      }
    }
    const outputName = (name: string): string => outputs.has(name) ? name
      : aliases.get(name) ?? aliases.get(basename(name)) ?? name
    const references = new Map<string, AssetReference[]>()
    for (const reference of this.references) {
      const host = outputName(reference.host)
      references.set(host, [...references.get(host) ?? [], reference])
    }
    const visitedOutputs = new Set<string>()
    const visitedModules = new Set<string>()
    const queue = ['index.html']
    const checkWorker = (key: string): void => {
      const inputs = this.workerInputs.get(key)
      if (inputs === undefined) throw new Error(`Web product isolation: worker ${key} has no recorded build inputs`)
      for (const input of inputs) this.inputs.assertInput(input)
    }
    const checkModule = (id: string): void => {
      if (visitedModules.has(id)) return
      this.inputs.assertInput(id)
      const info = moduleInfo(id)
      // This generated helper has no public record and does not prove an application input.
      if (info === null && id === ROLLDOWN_RUNTIME_MODULE_ID) return
      if (info === null) throw new Error(`Web product isolation: module ${id} has no Rollup module record`)
      visitedModules.add(id)
      if (info.isExternal === true || info.isExternal === undefined && info.code === null) {
        throw new Error(`Web product isolation: external module ${id} has no bundled input proof`)
      }
      if (/\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/i.test(id) && !this.cssInputs.has(id)) {
        throw new Error(`Web product isolation: stylesheet ${id} has no recorded transform inputs`)
      }
      if (/[?&](?:sharedworker|worker)(?:&|$)/.test(id)) checkWorker(physicalBundleInput(id) ?? id)
      for (const file of this.cssInputs.get(id) ?? []) this.inputs.assertInput(file)
      for (const files of this.moduleFiles.get(id)?.values() ?? []) {
        for (const file of files) this.inputs.assertInput(file)
      }
      for (const child of [...info.importedIds, ...info.dynamicallyImportedIds]) {
        const childInfo = moduleInfo(child)
        if (childInfo === null && child === ROLLDOWN_RUNTIME_MODULE_ID) continue
        if (childInfo === null) throw new Error(`Web product isolation: module ${child} has no Rollup module record`)
        // An absent inclusion flag is unknown, never evidence that a dependency was excluded.
        if (childInfo.isIncluded !== false || childInfo.isExternal === true) checkModule(child)
      }
    }
    for (const name of queue) {
      const file = outputName(name)
      if (visitedOutputs.has(file)) continue
      visitedOutputs.add(file)
      const item = outputs.get(file)
      if (item === undefined) throw new Error(`Web product isolation: referenced output ${file} is missing`)
      if (this.workerInputs.has(file)) checkWorker(file)
      else if (item.type === 'chunk') {
        for (const id of Object.keys(item.modules)) checkModule(id)
        queue.push(...item.imports, ...item.dynamicImports)
        if (item.implicitlyLoadedBefore !== undefined) queue.push(...item.implicitlyLoadedBefore)
        if (item.referencedFiles !== undefined) queue.push(...item.referencedFiles)
        queue.push(...item.viteMetadata?.importedCss ?? [], ...item.viteMetadata?.importedAssets ?? [])
      } else if (cssOwners.has(file)) {
        for (const id of cssOwners.get(file) ?? []) checkModule(id)
      } else {
        if (item.originalFileNames.length === 0) {
          throw new Error(`Web product isolation: asset ${file} has no recorded original files`)
        }
        for (const original of item.originalFileNames) this.inputs.assertInput(resolve(this.webRoot, original))
      }
      for (const reference of references.get(file) ?? []) {
        if (reference.type === 'public') this.inputs.assertInput(resolve(this.webRoot, 'public', reference.file))
        else queue.push(reference.file)
      }
    }
    if (visitedModules.size === 0) throw new Error('Web product isolation: index.html has no recorded reachable modules')
  }

}
