/** Complete NUL-delimited Git inventory for repository-wide source checks. */
import { execFileSync } from 'node:child_process'

/**
 * Read every tracked pathname without Git quoting or Node's one-MiB default truncation.
 * @param root - Repository working directory.
 * @returns Complete tracked paths, including Unicode and embedded newlines.
 * @throws The Git failure or an output larger than the existing 64-MiB repository inventory budget.
 */
export function trackedRepositoryFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(file => file !== '')
}
