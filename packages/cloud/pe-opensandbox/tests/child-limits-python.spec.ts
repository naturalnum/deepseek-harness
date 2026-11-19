/** Python guardian applies the matched handshake profile to each user child. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SLICE_LIMITS } from '../src/agent-data/constants.ts'

it.skipIf(process.platform === 'win32')('sets overridable compute concurrency defaults in the command world', () => {
  const directory = fileURLToPath(new URL('../runtime/agent', import.meta.url))
  const program = String.raw`
import subprocess, sys
sys.path.insert(0, sys.argv[1])
import launcher, paths
for key in ['OPENBLAS_NUM_THREADS', 'MAX_CONCURRENCY', 'MALLOC_ARENA_MAX']:
    assert paths.ENV[key] == '1'
    argv = launcher.world_argv('/srv/project')
    i = argv.index(key)
    assert argv[i - 1:i + 2] == ['--setenv', key, '1']
    assert subprocess.check_output(['/bin/sh', '-c', 'printf %s "$' + key + '"'], env=paths.ENV) == b'1'
    assert subprocess.check_output(['/bin/sh', '-c', key + '=2; export ' + key + '; printf %s "$' + key + '"'], env=paths.ENV) == b'2'
`
  execFileSync('python3', ['-I', '-S', '-B', '-c', program, directory], { timeout: 10000 })
})

it.skipIf(process.platform === 'win32')('allows 100 MiB and rejects sizes above the fixed 128 MiB child file limit', () => {
  const directory = fileURLToPath(new URL('../runtime/agent', import.meta.url))
  const program = String.raw`
import errno, json, os, resource, sys, tempfile
sys.path.insert(0, sys.argv[1])
import guardian
actual = resource.setrlimit
calls = {}
def set_limit(kind, limits):
    calls[str(kind)] = list(limits)
    if kind == resource.RLIMIT_FSIZE:
        actual(kind, limits)
resource.setrlimit = set_limit
guardian.child_limits()
with tempfile.TemporaryFile() as f:
    for size in (100 * 1024 * 1024, 128 * 1024 * 1024):
        os.ftruncate(f.fileno(), size)
        assert os.fstat(f.fileno()).st_size == size
    try: os.ftruncate(f.fileno(), 128 * 1024 * 1024 + 1)
    except OSError as error: assert error.errno == errno.EFBIG
    else: raise AssertionError('oversize file was permitted')
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (134217728, 134217728)
try: actual(resource.RLIMIT_FSIZE, (134217729, 134217729))
except (ValueError, OSError): pass
else: raise AssertionError('child could raise its hard limit')
print(json.dumps({'file':calls[str(resource.RLIMIT_FSIZE)][0], 'address':calls[str(resource.RLIMIT_AS)][0]}))
`
  const result = JSON.parse(execFileSync('python3', ['-I', '-S', '-B', '-c', program, directory], {
    encoding: 'utf8', timeout: 10000,
  })) as { file: number; address: number }
  expect(result.file).toBe(SLICE_LIMITS.childFileBytes)
  expect(result.address).toBe(SLICE_LIMITS.childAddressBytes)
})

it.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('applies the fixed limits across Bash exec and children without changing the supervisor', () => {
  const runtime = fileURLToPath(new URL('../runtime/agent', import.meta.url))
  const probe = fileURLToPath(new URL('./fixtures/child-resource-limits.py', import.meta.url))
  const observed = JSON.parse(execFileSync('python3', ['-I', '-S', '-B', probe, runtime], {
    encoding: 'utf8', timeout: 10000,
  })) as Record<string, readonly number[]>
  expect(observed).toEqual({
    cpu: [SLICE_LIMITS.childCpuSeconds, SLICE_LIMITS.childCpuSeconds],
    address: [SLICE_LIMITS.childAddressBytes, SLICE_LIMITS.childAddressBytes],
    files: [SLICE_LIMITS.childFileBytes, SLICE_LIMITS.childFileBytes],
    descriptors: [SLICE_LIMITS.childOpenFiles, SLICE_LIMITS.childOpenFiles],
    processes: [SLICE_LIMITS.childProcesses, SLICE_LIMITS.childProcesses],
    core: [SLICE_LIMITS.childCoreBytes, SLICE_LIMITS.childCoreBytes],
  })
})
