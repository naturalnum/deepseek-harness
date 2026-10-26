/** Test-only ABI1 reader: actual bounded no-follow file reads, synthetic ownership supplied by the worker fixture. */
const fs = require('node:fs')
const { workerData } = require('node:worker_threads')
module.exports = {
  abiVersion: 1,
  probe() { throw new Error('No kernel probe belongs to this configuration regression') },
  readRecord(path, maximum, maxPathBytes) {
    const fixture = workerData.fixture
    if (![fixture.planPath, fixture.proofPath].includes(path) || Buffer.byteLength(path) > maxPathBytes) throw new Error('Wrong protected selector')
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let raw
    try {
      const info = fs.fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || info.size > maximum || (info.mode & 0o022) !== 0) throw new Error('Wrong record facts')
      raw = fs.readFileSync(fd)
      if (raw.byteLength < 1 || raw.byteLength > maximum) throw new Error('Unbounded record')
    } finally { fs.closeSync(fd) }
    Atomics.add(new Int32Array(fixture.reads), path === fixture.proofPath ? 1 : 0, 1)
    return Uint8Array.from(raw)
  },
}
