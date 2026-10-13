/** Named cloud release scope with complete discovery and retained full backlog admission. */
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { corpusErrors, inventory } from './cloud-policy.mjs'

/** Explicit classification table shared by cloud runners and instrumentation. */
export const scopeManifestPath = 'products/power-evolve/scripts/cloud-scope-mcp-pdf.json'
const fields = ['runtime', 'sourceTests', 'builtTests', 'nativeAssets', 'tooling', 'docMetadata', 'docs', 'manifests']
const statuses = ['enabled', 'shared', 'deferred']

/** Reject omissions, stale records, unreviewed deferrals and missing file ownership.
 * @param full Complete authored discovery.
 * @param manifest Reviewed classifications and exact deferred paths.
 * @returns Located diagnostics; empty admits the named scope.
 */
export function scopeManifestErrors(full, manifest) {
  const errors = [], seen = new Set()
  if (manifest.schemaVersion !== 1 || manifest.name !== 'mcp-pdf' || manifest.status !== 'current'
    || !Array.isArray(manifest.entries) || !manifest.reasons || !manifest.approvedDeferrals) {
    return ['scope: invalid or unapproved current manifest']
  }
  for (const item of manifest.entries) {
    const key = item.kind + ':' + item.path
    if (seen.has(key)) errors.push('scope: duplicate record: ' + key)
    seen.add(key)
    if (!fields.includes(item.kind) || !full[item.kind].includes(item.path)) errors.push('scope: stale record: ' + key)
    if (!statuses.includes(item.status) || typeof item.owner !== 'string' || !item.owner.trim() || !manifest.reasons[item.reason]) {
      errors.push('scope: missing classification, owner or reason: ' + key)
    }
    if (item.status === 'deferred' && !manifest.approvedDeferrals[item.kind]?.includes(item.path)) {
      errors.push('scope: unreviewed deferral: ' + key)
    }
  }
  for (const field of fields) {
    for (const file of full[field]) if (!seen.has(field + ':' + file)) errors.push('scope: unclassified file: ' + field + ':' + file)
    for (const file of manifest.approvedDeferrals[field] ?? []) {
      if (!manifest.entries.some(item => item.kind === field && item.path === file && item.status === 'deferred')) {
        errors.push('scope: approved deferred record missing: ' + field + ':' + file)
      }
    }
    for (const status of statuses) {
      const actual = manifest.entries.filter(item => item.kind === field && item.status === status).length
      if (manifest.counts?.[field]?.[status] !== actual) errors.push('scope: stale count: ' + field + ':' + status)
    }
  }
  const classifiedLint = new Set(manifest.entries.filter(item => ['runtime', 'sourceTests', 'builtTests', 'tooling'].includes(item.kind))
    .map(item => item.path))
  for (const item of manifest.lintSupport ?? []) {
    if (classifiedLint.has(item.path) || !full.lint.includes(item.path) || item.status !== 'shared'
      || typeof item.owner !== 'string' || !item.owner.trim() || !manifest.reasons[item.reason]) {
      errors.push('scope: invalid lint support record: ' + item.path)
    }
    classifiedLint.add(item.path)
  }
  for (const file of full.lint) if (!classifiedLint.has(file)) errors.push('scope: unclassified lint file: ' + file)
  const coverage = manifest.policy?.coverage
  if (coverage?.perFile !== true || ['lines', 'statements', 'functions', 'branches'].some(metric => coverage[metric] !== 100)) {
    errors.push('scope: all four per-file coverage thresholds must remain 100')
  }
  return errors
}

/** Reject kept runtime imports or re-exports of deferred implementation files.
 * @param root Checkout or isolated source fixture root.
 * @param full Complete runtime discovery.
 * @param deferred Exact reviewed runtime deferrals.
 * @returns Located imports that would reactivate a deferred implementation.
 */
export function deferredRuntimeImportErrors(root, full, deferred) {
  const errors = [], targets = new Set(deferred)
  for (const file of full.runtime.filter(file => !targets.has(file))) {
    const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      let specifier
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings
        if (!(bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0
          && bindings.elements.every(binding => binding.isTypeOnly) && !node.importClause?.name)) specifier = node.moduleSpecifier.text
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text
      if (specifier?.startsWith('.')) {
        const target = relative(root, resolve(root, dirname(file), specifier)).replaceAll('\\', '/')
        if (targets.has(target)) errors.push('scope: kept runtime imports deferred runtime: ' + file + ' -> ' + target)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return errors
}

/** Resolve current MCP/PDF or full backlog through the same complete classification table.
 * @param root Checkout root.
 * @param selection Explicit current or full entry; defaults to the current release.
 * @returns Selected corpus, full discovery and retained full baseline.
 */
export function cloudScope(root, selection = process.env.PE_CLOUD_SCOPE ?? 'current') {
  if (!['current', 'full'].includes(selection)) throw new Error('scope: expected current or full, got ' + selection)
  const full = inventory(root), manifest = JSON.parse(readFileSync(resolve(root, scopeManifestPath), 'utf8'))
  const baseline = JSON.parse(readFileSync(resolve(root, manifest.fullCorpus), 'utf8'))
  const errors = [...scopeManifestErrors(full, manifest), ...corpusErrors(full, baseline)]
  const deferred = manifest.entries.filter(item => item.status === 'deferred').map(item => item.path)
  errors.push(...deferredRuntimeImportErrors(root, full, manifest.approvedDeferrals.runtime))
  if (errors.length) throw new Error(errors.join('\n'))
  const corpus = Object.fromEntries(Object.entries(full).map(([field, files]) =>
    [field, selection === 'full' ? files : files.filter(file => !deferred.includes(file))]))
  return { selection, name: selection === 'full' ? 'full' : manifest.name, manifestPath: scopeManifestPath,
    corpus, full, baseline, deferred }
}
