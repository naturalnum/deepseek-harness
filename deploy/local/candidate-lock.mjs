/** Respect the candidate reservation shared by the development lines. */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { CandidateError } from './inspect.mjs'

/** Remove the optional calling-line identity before forwarding smoke-check arguments. */
export function readLineArguments(argv) {
  const args = []
  let line
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--line') { args.push(argv[index]); continue }
    const value = argv[++index]
    if (line !== undefined || !value || value.startsWith('--')) throw new CandidateError('--line 需要一个调用线名。')
    line = value
  }
  return { line, args }
}

/** Refuse another line's reservation; an idle candidate retains the original command interface. */
export async function assertCandidateLock(workDirectory, line) {
  const directory = join(workDirectory, 'locks', 'candidate')
  let owner
  try { owner = (await readFile(join(directory, 'owner'), 'utf8')).split('\n')[0] }
  catch (error) {
    if (error.code !== 'ENOENT') throw new CandidateError('无法读取候选环境锁，请先核对锁的持有者。')
    try { await stat(directory) }
    catch (missing) { if (missing.code === 'ENOENT') return; throw new CandidateError('无法确认候选环境锁。') }
    throw new CandidateError('候选环境锁已存在但持有者未确认，不能操作。')
  }
  if (!line || !owner.includes(' | ') || owner.split(' | ')[0] !== line) {
    throw new CandidateError('候选环境锁被别的线持有或未提供 --line；没有执行操作。')
  }
}
