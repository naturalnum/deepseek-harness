/** Typed source-test access to the native collector's JavaScript helpers. */

/** Native Node environment values transported without shell interpolation. */
export interface NativeCoverageEnvironment {
  PE_CLOUD_COVERAGE_INPUT: string
  NODE_V8_COVERAGE: string
  NODE_OPTIONS: string
}

/** Named source selection and its frozen repository-relative manifest. */
export interface NativeCoverageScope {
  selection: string
  manifest: string
}

/** Original raw execution identity retained by each source-map conversion. */
export interface NativeCoverageConversion {
  raw: string
  context: string
  file: string
  scriptId: string
  actualUrl: string
  executionRoot: string
  executedHash: string
  mapped: boolean
}

/** Hash original or executed source bytes.
 * @param source UTF-8 text or bytes.
 * @returns SHA-256 digest.
 */
export function sourceHash(source: string | Uint8Array): string

/** Freeze complete native runtime and test inputs.
 * @param root Absolute checkout or fixture root.
 * @param runtime Complete runtime file list.
 * @param tests Required native test file list.
 * @param directory Fresh evidence directory.
 * @param scope Optional named source selection.
 * @returns Absolute frozen input manifest path.
 */
export function prepareNativeCoverage(root: string, runtime: readonly string[], tests: readonly string[], directory: string,
  scope?: NativeCoverageScope): string

/** Supply native collection and the source loader.
 * @param inputPath Frozen input manifest path.
 * @returns Environment values for the native runner and its subprocesses.
 */
export function nativeCoverageEnvironment(inputPath: string): NativeCoverageEnvironment

/** Remove only the gate-added TypeScript loader for an explicitly JavaScript child.
 * @param environment Parent environment; defaults to the current process.
 * @returns Environment retaining source collection and the user's Node options.
 */
export function nativePureJavaScriptChildEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv

/** Allocate one actual execution namespace.
 * @param inputPath Frozen parent input manifest path.
 * @param options Canonical execution paths and optional collector URL.
 * @returns The local namespace and its transported environment.
 */
export function prepareNativeCoverageContext(inputPath: string, options?: {
  executionRoot?: string
  executionDirectory?: string
  collector?: string
}): { directory: string; inputPath: string; environment: NativeCoverageEnvironment }

/** Mount frozen source readonly and only this fresh capture namespace writable.
 * @param inputPath Frozen parent input manifest path.
 * @param options Optional actual byte-copy execution root.
 * @returns Arguments for Docker create or run.
 */
export function nativeDockerCoverageArguments(inputPath: string, options?: { executionRoot?: string }): string[]

/** Resolve a native V8 script URL.
 * @param root Physical source root.
 * @param url Native script URL.
 * @returns Relative source path, or undefined for a non-file URL.
 */
export function nativeSourcePath(root: string, url: string): string | undefined

/** Convert genuine process coverage and retain its execution identities.
 * @param inputPath Frozen native input manifest path.
 * @returns Source coverage and the observed test and conversion records.
 */
export function convertNativeCoverage(inputPath: string): Promise<{
  map: { files(): string[]; toJSON(): Record<string, unknown> }
  facts: {
    inputPath: string
    scope?: NativeCoverageScope & { hash: string }
    observedTests: string[]
    conversions: NativeCoverageConversion[]
    files: string[]
  }
}>
