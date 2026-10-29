/** Python guardian applies the matched handshake profile to each user child. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SLICE_LIMITS } from '../src/agent-data/constants.ts'

it.skipIf(process.platform === 'win32')('sets an overridable OpenBLAS default in the command world', () => {
  const directory = fileURLToPath(new URL('../runtime/agent', import.meta.url))
  const program = String.raw`
import subprocess, sys
sys.path.insert(0, sys.argv[1])
import launcher, paths
assert paths.ENV['OPENBLAS_NUM_THREADS'] == '1'
argv = launcher.world_argv('/srv/project')
i = argv.index('OPENBLAS_NUM_THREADS')
assert argv[i - 1:i + 2] == ['--setenv', 'OPENBLAS_NUM_THREADS', '1']
assert subprocess.check_output(['/bin/sh', '-c', 'printf %s "$OPENBLAS_NUM_THREADS"'], env=paths.ENV) == b'1'
assert subprocess.check_output(['/bin/sh', '-c', 'OPENBLAS_NUM_THREADS=2; export OPENBLAS_NUM_THREADS; printf %s "$OPENBLAS_NUM_THREADS"'], env=paths.ENV) == b'2'
`
  execFileSync('python3', ['-I', '-S', '-B', '-c', program, directory], { timeout: 10000 })
})

it.skipIf(process.platform === 'win32')('sets the fixed child limits and rejects a file beyond the process limit', () => {
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
assert calls[str(resource.RLIMIT_AS)] == [536870912, 536870912]
assert calls[str(resource.RLIMIT_FSIZE)] == [67108864, 67108864]
with tempfile.TemporaryFile() as f:
    os.ftruncate(f.fileno(), 16 * 1024 * 1024)
    try: os.ftruncate(f.fileno(), 67108865)
    except OSError as error: assert error.errno == errno.EFBIG
    else: raise AssertionError('oversize file was permitted')
try: actual(resource.RLIMIT_FSIZE, (67108865, 67108865))
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
