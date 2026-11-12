/** Compare existing persistent-format declarations without loading product modules or opening databases. */
const fs = require('node:fs')
const path = require('node:path')

function declaredVersion(filename, symbol) {
  const text = fs.readFileSync(filename, 'utf8')
  const match = text.match(new RegExp(`\\b(?:const|let|var)\\s+${symbol}\\s*=\\s*(\\d+)\\b`))
  if (!match) throw new Error('A persistent-format declaration is missing from the selected product.')
  return Number(match[1])
}

function exportedVersion(root, packagePath, exportName, symbol) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, packagePath, 'package.json'), 'utf8'))
  const declaration = manifest.exports[exportName]
  const entry = typeof declaration === 'string' ? declaration : declaration?.default
  if (typeof entry !== 'string' || !entry.startsWith('./') || entry.split('/').includes('..')) {
    throw new Error('A persistent-format package export is unavailable.')
  }
  return declaredVersion(path.join(root, packagePath, entry), symbol)
}

function versions(root) {
  return {
    session: exportedVersion(root, 'packages/core/session', './types', 'SESSION_FORMAT_VERSION'),
    storageSqlite: exportedVersion(root, 'packages/storage/storage-sqlite', '.', 'STORAGE_SQLITE_SCHEMA_VERSION'),
    sessionQuerySqlite: exportedVersion(root, 'packages/session-query/session-query-sqlite', '.', 'SESSION_QUERY_SQLITE_SCHEMA_VERSION'),
    airalogyRecord: declaredVersion(path.join(root, 'integrations/epri-research/src/reused/aira/index.ts'), 'AIRALOGY_RECORD_SCHEMA_VERSION'),
  }
}

/**
 * Compare declared record/schema versions and the changed compiled database migrations.
 * @param {string} productRoot - Current installed product directory.
 * @param {string} nextRoot - Verified staged product directory.
 * @param {object} plan - Changed, added and removed product paths from the rollback plan.
 * @returns {object} Before/after versions, changed migration paths and the resulting restoration requirement.
 */
function compareDataFormats(productRoot, nextRoot, plan) {
  const before = versions(productRoot)
  const after = versions(nextRoot)
  const migrationFiles = [...new Set([...plan.changed, ...plan.added, ...plan.removed]
    .filter(name => /\/lib\/(?:types\/)?migrations\/.*\.js$/.test(name)))].sort()
  const migrationChanged = migrationFiles.length > 0
  return { before, after, migrationFiles, migrationChanged,
    changed: migrationChanged || Object.keys(before).some(name => before[name] !== after[name]) }
}

module.exports = { compareDataFormats }
