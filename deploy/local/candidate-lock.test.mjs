import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertCandidateLock, readLineArguments } from './candidate-lock.mjs'

async function withWork(run) {
  const work = await mkdtemp(join(tmpdir(), 'pe-candidate-line-'))
  try { await run(work, join(work, 'locks', 'candidate')) }
  finally { await rm(work, { recursive: true, force: true }) }
}

test('line identity is removed while original smoke arguments retain their order', () => {
  assert.deepEqual(readLineArguments(['bundle', '--line', '交付线', '--account', 'ordinaryUserC']), {
    line: '交付线', args: ['bundle', '--account', 'ordinaryUserC'],
  })
  assert.deepEqual(readLineArguments(['--account', 'ordinaryUserC']), { line: undefined, args: ['--account', 'ordinaryUserC'] })
  assert.throws(() => readLineArguments(['--line', '--account']), /调用线名/)
})

test('an idle candidate preserves the old command interface without claiming a new reservation', async () => {
  await withWork(async (work, lock) => {
    await assertCandidateLock(work)
    await assert.rejects(stat(lock), error => error.code === 'ENOENT')
  })
})

test('a held reservation accepts exactly its first owner segment and remains owned by that line', async () => {
  await withWork(async (work, lock) => {
    await mkdir(lock, { recursive: true })
    const owner = '交付线 | 迭代 002 | 更新候选 | 起\n123\n'
    await writeFile(join(lock, 'owner'), owner)
    await assertCandidateLock(work, '交付线')
    await assert.rejects(assertCandidateLock(work, '接口线'), /没有执行操作/)
    await assert.rejects(assertCandidateLock(work), /没有执行操作/)
    assert.equal(await readFile(join(lock, 'owner'), 'utf8'), owner)
  })
})

test('a reservation whose owner is not yet written is not mistaken for an idle candidate', async () => {
  await withWork(async (work, lock) => {
    await mkdir(lock, { recursive: true })
    await assert.rejects(assertCandidateLock(work, '交付线'), /持有者未确认/)
  })
})
