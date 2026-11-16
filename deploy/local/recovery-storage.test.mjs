import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureRecoveryStorage, inspectRecoveryProductMount, observeRecoveryLoops, restoreRecoveryStorage } from './recovery-storage.mjs'

function fixture({ support = false } = {}) {
  const resourceId = '00000000-0000-4000-8000-000000000014', root = '/srv/dsh-features-' + resourceId
  const slots = ['a', 'b', 'c'].map(slotId => ({ slotId }))
  const roles = ['arena', 'control', ...slots.flatMap(slot => ['private', 'projects', 'environments/slot-0'].map(kind => slot.slotId + '/' + kind))]
  const rows = roles.map((role, index) => ({ role, image: index === 0 ? '/backings/arena.ext4' : root + '/arena/backings/' + index + '.ext4',
    ...(index >= 2 ? { account: true, executable: role.includes('environments') } : {}),
    mountPath: root + '/' + role, loop: '/dev/loop' + (100 + index), device: String(1000 + index), inode: '2',
    backingDevice: index === 0 ? '42' : '1000', backingInode: String(2000 + index), backingBytes: '67108864',
    filesystemBytes: '60000000', filesystemInodes: '8192' }))
  const owner = { schema: 'dsh-static-storage-v3-owner/v1', phase: 'preallocated-and-measured-not-activated', resourceId, slots, domains: rows }
  const supportRows = support ? [
    { role: 'products', image: '/support/products.ext4', mountPath: '/opt/dsh-installed-products', loop: '/dev/loop80', device: '41', readOnly: true },
    { role: 'arena-parent', image: '/support/anchor.ext4', mountPath: '/backings', loop: '/dev/loop81', device: '42', readOnly: false },
  ].map((row, index) => ({ ...row, inode: '2', backingDevice: '9', backingInode: String(3000 + index),
    backingBytes: '67108864', filesystemBytes: '60000000', filesystemInodes: '8192' })) : []
  const allRows = [...supportRows, ...rows]
  const loops = new Set(allRows.map(row => row.loop)), mounts = new Set(allRows.map(row => row.mountPath)), calls = []
  const uuid = row => '00000000-0000-4000-8000-' + String(allRows.indexOf(row)).padStart(12, '0')
  const io = {
    platform: () => true,
    mounts: () => allRows.filter(row => mounts.has(row.mountPath)).map(row => ({ path: row.mountPath, root: '/', filesystem: 'ext4', source: row.loop,
      options: [row.readOnly ? 'ro' : 'rw', 'nodev', 'nosuid', ...(row.role === 'products' || row.role.includes('environments') ? [] : ['noexec'])] })),
    loops: () => [...loops].map(name => { const row = allRows.find(row => row.loop === name)
      return { name, 'back-file': row.image, 'back-ino': row.backingInode,
        'back-maj:min': row.backingDevice === '1000' ? '3:232' : '0:' + row.backingDevice,
        offset: '0', sizelimit: '0', ro: row.readOnly === true } }),
    backing: path => {
      const row = allRows.find(row => row.image === path)
      if (rows.includes(row) && row.role !== 'arena' && !mounts.has(rows[0].mountPath)
        || support && row.role === 'arena' && !mounts.has('/backings')) throw new Error('parent mount not restored')
      return { device: row.backingDevice, inode: row.backingInode, bytes: row.backingBytes }
    },
    uuid: path => uuid(allRows.find(row => row.image === path || row.loop === path)),
    domain: path => {
      const row = allRows.find(row => row.mountPath === path)
      return { ...row, uid: row.account ? 2000 : 0, gid: row.account ? 2000 : 0, mode: row.account ? 0o700 : 0o755 }
    },
    bind: row => { calls.push(['bind', row.role]); loops.add(row.loop) },
    mount: row => { calls.push(['mount', row.role]); mounts.add(row.mountPath) },
  }
  return { owner, rows, supportRows, io, loops, mounts, calls }
}

test('cold recovery restores the observed read-only products and backing parent before the eleven data domains', () => {
  const f = fixture({ support: true }), scope = { installAnchor: '/opt/dsh-installed-products/assets', applicationPid: 123 }
  const snapshot = captureRecoveryStorage(f.owner, f.io, scope)
  assert.deepEqual(snapshot.support.map(row => [row.role, row.readOnly, row.loop]),
    [['products', true, '/dev/loop80'], ['arena-parent', false, '/dev/loop81']])
  f.loops.clear(); f.mounts.clear()
  const check = restoreRecoveryStorage(snapshot, { io: f.io, check: true })
  assert.deepEqual(check.domains, [{ role: 'products', ready: false, changed: false }])
  assert.deepEqual(f.calls, [])
  const result = restoreRecoveryStorage(snapshot, { io: f.io })
  assert.equal(result.ready, true)
  assert.equal(result.domains.length, 13)
  assert.deepEqual(f.calls, [...f.supportRows, ...f.rows].flatMap(row => [['bind', row.role], ['mount', row.role]]))
  assert.equal(f.io.loops().find(row => row.name === '/dev/loop80').ro, true)
  f.calls.length = 0
  assert.equal(restoreRecoveryStorage(snapshot, { io: f.io }).ready, true)
  assert.deepEqual(f.calls, [])
})

test('a private product overlay or occupied original support loop refuses before any mutation', () => {
  const f = fixture({ support: true }), scope = { installAnchor: '/opt/dsh-installed-products/assets', applicationPid: 123 }
  const originalMounts = f.io.mounts
  f.io.mounts = pid => [...originalMounts(), ...(pid ? [{ path: '/opt/dsh-installed-products/foreign', source: '/dev/loop999', root: '/', filesystem: 'ext4', options: ['ro'] }] : [])]
  assert.throws(() => captureRecoveryStorage(f.owner, f.io, scope))
  f.io.mounts = originalMounts
  const snapshot = captureRecoveryStorage(f.owner, f.io, scope), originalLoops = f.io.loops
  f.io.loops = () => originalLoops().map(row => row.name === '/dev/loop80' ? { ...row, 'back-ino': '99999' } : row)
  assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }), error => error.completedDomains.length === 0)
  assert.deepEqual(f.calls, [])
})

test('kernel backing identity survives a changed displayed path after the original namespace is gone', () => {
  const f = fixture({ support: true }), scope = { installAnchor: '/opt/dsh-installed-products/assets', applicationPid: 123 }
  const snapshot = captureRecoveryStorage(f.owner, f.io, scope), original = f.io.loops
  f.io.loops = () => original().map(row => ({ ...row, 'back-file': '/kernel-relative/alias.ext4' }))
  assert.equal(restoreRecoveryStorage(snapshot, { io: f.io, check: true }).ready, true)
  assert.deepEqual(f.calls, [])
})

test('a new capture reuses protected original support paths when kernel identity rows carry no display path', () => {
  const f = fixture({ support: true }), scope = { installAnchor: '/opt/dsh-installed-products/assets', applicationPid: 123 }
  const before = captureRecoveryStorage(f.owner, f.io, scope), original = f.io.loops
  f.io.loops = () => original().map(({ 'back-file': display, ...identity }) => identity)
  const observed = captureRecoveryStorage(f.owner, f.io, { ...scope,
    supportBackings: before.support.map(row => ({ role: row.role, image: row.image })) })
  assert.equal(restoreRecoveryStorage(observed, { io: f.io, check: true }).ready, true)
  assert.deepEqual(f.calls, [])
})

test('changed kernel backing identity, offset, size or readonly bit refuses before a mount', () => {
  for (const change of [{ 'back-ino': '9007199254740993' }, { 'back-maj:min': '7:43' }, { offset: '4096' }, { sizelimit: '4096' }, { ro: false }]) {
    const f = fixture({ support: true }), scope = { installAnchor: '/opt/dsh-installed-products/assets', applicationPid: 123 }
    const snapshot = captureRecoveryStorage(f.owner, f.io, scope), original = f.io.loops
    f.io.loops = () => original().map(row => row.name === '/dev/loop80' ? { ...row, ...change } : row)
    assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }), error => error.completedDomains.length === 0 && !error.mutationAttempted)
    assert.deepEqual(f.calls, [])
  }
})

test('actual domain observations produce only owned metadata and an idempotent check', () => {
  const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io)
  assert.equal(snapshot.owner.domains.length, 11)
  assert.equal(snapshot.owner.domains[0].fsUuid, f.io.uuid(f.rows[0].loop))
  const before = structuredClone(snapshot)
  assert.equal(restoreRecoveryStorage(snapshot, { io: f.io, check: true }).ready, true)
  assert.equal(restoreRecoveryStorage(snapshot, { io: f.io }).ready, true)
  assert.deepEqual(snapshot, before); assert.deepEqual(f.calls, [])
})

test('cold storage restoration retains original numbers and mounts the arena before its ten child backings', () => {
  const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io)
  f.loops.clear(); f.mounts.clear()
  const result = restoreRecoveryStorage(snapshot, { io: f.io })
  assert.equal(result.ready, true)
  assert.equal(result.domains.filter(row => row.changed).length, 11)
  assert.deepEqual(f.calls, f.rows.flatMap(row => [['bind', row.role], ['mount', row.role]]))
  f.calls.length = 0
  assert.equal(restoreRecoveryStorage(snapshot, { io: f.io }).ready, true)
  assert.deepEqual(f.calls, [])
})

test('read-only check stops at the missing arena and never reads hidden child backings', () => {
  const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io)
  f.loops.clear(); f.mounts.clear()
  const result = restoreRecoveryStorage(snapshot, { io: f.io, check: true })
  assert.deepEqual(result, { ready: false, check: true, domains: [{ role: 'arena', ready: false, changed: false }] })
  assert.deepEqual(f.calls, [])
})

test('an occupied original loop or duplicate backing binding stops without moving any data', () => {
  for (const conflict of [rows => rows[0]['back-ino'] = '99999', rows => rows.push({ ...rows[0], name: '/dev/loop999' })]) {
    const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io), original = f.io.loops
    f.io.loops = () => { const rows = original(); conflict(rows); return rows }
    assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }), error => error.completedDomains.length === 0)
    assert.deepEqual(f.calls, [])
  }
})

test('unknown mutation result retains completed domains and is never replayed', () => {
  const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io)
  f.loops.clear(); f.mounts.clear()
  f.io.bind = row => { f.calls.push(['bind', row.role]); if (row.role === 'control') throw new Error('unknown'); f.loops.add(row.loop) }
  assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }), error => error.completedDomains.length === 1)
  assert.deepEqual(f.calls, [['bind', 'arena'], ['mount', 'arena'], ['bind', 'control']])
})

test('changed inode, subdirectory mounts, permission drift and executable policy conflicts refuse', () => {
  for (const change of [f => { f.io.backing = () => ({ device: '1', inode: '2', bytes: '67108864' }) },
    f => { const original = f.io.mounts; f.io.mounts = () => original().map(row => ({ ...row, root: '/subdirectory' })) },
    f => { const original = f.io.domain; f.io.domain = path => ({ ...original(path), mode: 0o777 }) },
    f => { const original = f.io.mounts; f.io.mounts = () => original().map(row => ({ ...row, options: ['rw', 'nodev', 'nosuid', 'noexec'] })) }]) {
    const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io); change(f)
    assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }))
    assert.deepEqual(f.calls, [])
  }
})

test('cancellation or an elapsed original deadline stops before any original loop mutation', () => {
  for (const kind of ['cancelled', 'timed-out']) {
    const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io), controller = new AbortController()
    f.loops.clear(); f.mounts.clear()
    if (kind === 'cancelled') controller.abort()
    assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io, signal: controller.signal,
      ...(kind === 'timed-out' ? { deadlineAtMs: performance.now() - 1 } : {}) }), error => {
      assert.equal(error.recoveryOutcome, kind); assert.equal(error.mutationAttempted, false)
      return true
    })
    assert.deepEqual(f.calls, [])
  }
})

test('cancellation after a confirmed original bind stops the dependent mount and preserves responsibility', () => {
  const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io), controller = new AbortController()
  f.loops.clear(); f.mounts.clear()
  f.io.bind = row => { f.calls.push(['bind', row.role]); f.loops.add(row.loop); controller.abort() }
  assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io, signal: controller.signal }), error => {
    assert.equal(error.recoveryOutcome, 'cancelled'); assert.equal(error.mutationAttempted, true)
    assert.equal(error.recoveryDomain, 'arena'); return true
  })
  assert.deepEqual(f.calls, [['bind', 'arena']])
  assert.equal(f.loops.has(f.rows[0].loop), true)
})

function productBindFixture() {
  const f = fixture(), root = '/opt/dsh-installed-products'
  const source = { device: '99', inode: '333', uid: 0, gid: 0, mode: 0o755 }
  const parent = { path: '/', root: '/', device: '0:99', filesystem: 'overlay', source: 'overlay', options: ['rw', 'relatime'] }
  const state = { mounted: true, readOnly: true, mountRoot: root, privateChild: false }
  const pins = { manifestSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), files: 3, anchorSha256: 'c'.repeat(64) }
  const scope = { installAnchor: root + '/package.json', applicationPid: 123,
    productManifest: { path: '/opt/qualified/manifest.json', sha256: 'a'.repeat(64) } }
  const originalMounts = f.io.mounts
  f.io.mounts = pid => [...originalMounts(), parent, ...(state.mounted ? [{ ...parent, path: root, root: state.mountRoot,
    options: [state.readOnly ? 'ro' : 'rw', 'nosuid', 'nodev', 'relatime'] }] : []),
  ...(pid && state.privateChild ? [{ ...parent, path: root + '/foreign', options: ['ro'] }] : [])]
  f.io.productDirectory = () => ({ ...source })
  f.io.productPins = () => ({ ...pins })
  f.io.verifier = () => ({ path: '/opt/controls/recovery-storage.mjs', sha256: 'd'.repeat(64) })
  f.io.bindProduct = row => { f.calls.push(['product-bind', row.role]); state.mounted = true; state.readOnly = false }
  f.io.protectProduct = row => { f.calls.push(['product-readonly', row.role]); state.readOnly = true }
  return { ...f, source, state, pins, scope }
}

test('a measured V3 product self-bind is restored and reverified before the original eleven loops', () => {
  const f = productBindFixture(), snapshot = captureRecoveryStorage(f.owner, f.io, f.scope), product = snapshot.support[0]
  assert.equal(product.kind, 'bind'); assert.equal(product.sourcePath, '/opt/dsh-installed-products')
  assert.equal(product.loop, undefined); assert.deepEqual(product.productPins, f.pins)
  assert.deepEqual(inspectRecoveryProductMount(product, 123, f.io), { kind: 'bind', readOnly: true, verified: true })
  f.loops.clear(); f.mounts.clear(); f.state.mounted = false
  assert.deepEqual(restoreRecoveryStorage(snapshot, { io: f.io, check: true }).domains, [{ role: 'products', ready: false, changed: false }])
  assert.deepEqual(f.calls, [])
  assert.equal(restoreRecoveryStorage(snapshot, { io: f.io }).ready, true)
  assert.deepEqual(f.calls.slice(0, 2), [['product-bind', 'products'], ['product-readonly', 'products']])
  assert.equal(f.state.readOnly, true)
  assert.deepEqual(f.calls.slice(2), f.rows.flatMap(row => [['bind', row.role], ['mount', row.role]]))
  f.calls.length = 0
  assert.equal(restoreRecoveryStorage(snapshot, { io: f.io }).ready, true)
  assert.deepEqual(f.calls, [])
})

test('a missing independent bind, writable bind, foreign source or private submount cannot qualify from a normal manifest alone', () => {
  for (const change of [f => { f.state.mounted = false }, f => { f.state.readOnly = false },
    f => { f.state.mountRoot = '/foreign-product' }, f => { f.state.privateChild = true }]) {
    const f = productBindFixture(); change(f)
    assert.throws(() => captureRecoveryStorage(f.owner, f.io, f.scope))
    assert.deepEqual(f.calls, [])
  }
})

test('changed captured bind identity, product bytes or verifier cannot reach a dependent storage mutation', () => {
  for (const change of [f => { f.source.inode = '334' }, f => { f.source.mode = 0o777 },
    f => { f.pins.anchorSha256 = 'e'.repeat(64) }, f => { f.io.verifier = () => ({ path: '/opt/controls/recovery-storage.mjs', sha256: 'e'.repeat(64) }) }]) {
    const f = productBindFixture(), snapshot = captureRecoveryStorage(f.owner, f.io, f.scope); change(f)
    assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }), error => error.completedDomains.length === 0 && error.mutationAttempted === false)
    assert.deepEqual(f.calls, [])
  }
  const f = productBindFixture(), snapshot = captureRecoveryStorage(f.owner, f.io, f.scope)
  snapshot.support[0] = { kind: 'bind', role: 'products', allow: true }
  assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }))
  assert.deepEqual(f.calls, [])
})

test('cancellation after creating the actual product bind stops its remount and all original data mounts', () => {
  const f = productBindFixture(), snapshot = captureRecoveryStorage(f.owner, f.io, f.scope), controller = new AbortController()
  f.state.mounted = false
  const bind = f.io.bindProduct
  f.io.bindProduct = row => { bind(row); controller.abort() }
  assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io, signal: controller.signal }), error => {
    assert.equal(error.recoveryDomain, 'products'); assert.equal(error.recoveryOutcome, 'cancelled')
    assert.equal(error.mutationAttempted, true); assert.deepEqual(error.completedDomains, []); return true
  })
  assert.deepEqual(f.calls, [['product-bind', 'products']])
  assert.equal(f.state.readOnly, false)
})

test('cancellation during product pin validation stops before creating a missing bind', () => {
  const f = productBindFixture(), snapshot = captureRecoveryStorage(f.owner, f.io, f.scope), controller = new AbortController()
  f.state.mounted = false
  const pins = f.io.productPins
  f.io.productPins = (...args) => { const value = pins(...args); controller.abort(); return value }
  assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io, signal: controller.signal }), error => {
    assert.equal(error.recoveryOutcome, 'cancelled'); assert.equal(error.mutationAttempted, false)
    assert.deepEqual(error.completedDomains, []); return true
  })
  assert.deepEqual(f.calls, []); assert.equal(f.state.mounted, false)
})

function missingLoopFixture({ duplicate = false, changed = false, permission = false, wrongNode = false } = {}) {
  const directory = '/run/pe-cloud-recovery-loop-fixture', alias = directory + '/loop85', calls = [], removed = []
  const file = { dev: 37n, ino: 2n, uid: 0n, gid: 0n, mode: 0o40700n, isDirectory: () => true, isSymbolicLink: () => false }
  const node = { dev: 37n, ino: 3n, rdev: wrongNode ? 7n : 7n * 256n + 85n, uid: 0n, gid: 0n, mode: 0o60400n,
    nlink: 1n, ctimeNs: 1n, isBlockDevice: () => true, isSymbolicLink: () => false }
  let reads = 0
  const io = {
    readFileSync: path => {
      if (path === '/sys/class/block/loop85/dev') return '7:85\n'
      assert.ok(['/sys/class/block/loop85/loop/offset', '/sys/class/block/loop85/loop/sizelimit', '/sys/class/block/loop85/ro'].includes(path))
      return '0\n'
    },
    lstatSync: path => {
      if (path === '/dev/loop85') throw Object.assign(new Error('unavailable'), { code: permission ? 'EACCES' : 'ENOENT' })
      if (path === '/run') return { ...file, mode: 0o40755n }
      if (path === directory) return file
      assert.equal(path, alias); return node
    },
    mkdtempSync: prefix => { assert.equal(prefix, '/run/pe-cloud-recovery-loop-'); return directory },
    unlinkSync: path => removed.push(['unlink', path]), rmdirSync: path => removed.push(['rmdir', path]),
  }
  const run = (command, argv) => {
    calls.push([command, argv])
    if (command === 'mknod') { assert.deepEqual(argv, ['-m', '0400', alias, 'b', '7', '85']); return '' }
    assert.equal(command, 'losetup')
    if (argv.includes('--json')) return JSON.stringify({ loopdevices: [{ name: '/dev/loop54', 'back-file': '/a.ext4' }, { name: '/dev/loop85', 'back-file': '/b.ext4' }] })
    if (argv.at(-1) === alias) {
      reads++
      assert.deepEqual(argv.slice(0, 5), ['--list', '--raw', '--noheadings', '--output', 'NAME,BACK-INO,BACK-MAJ:MIN'])
      return alias + ' ' + (changed && reads === 2 ? '9007199254740994' : '9007199254740993') + ' 7:54'
    }
    return '/dev/loop54 ' + (duplicate ? '9007199254740993' : '14') + ' 7:54 0 0 0\n/dev/loop85\\x20(lost)   0 0 0'
  }
  return { io, run, calls, removed, directory, alias }
}

test('a missing foreign loop node is queried through private read-only aliases without losing 64-bit identity', () => {
  const f = missingLoopFixture(), rows = observeRecoveryLoops(f.run, f.io)
  assert.equal(rows[1].name, '/dev/loop85')
  assert.equal(rows[1]['back-ino'], '9007199254740993')
  assert.deepEqual(f.removed, [['unlink', f.alias], ['rmdir', f.directory]])
  assert.equal(f.calls.filter(([command]) => command === 'mknod').length, 1)
  assert.equal(f.calls.filter(([command, argv]) => command === 'losetup' && argv.at(-1) === f.alias).length, 2)
  assert.ok(f.calls.every(([command, argv]) => command === 'mknod' || argv[0] === '--list'))
})

test('lost-node observations refuse permission errors, wrong devices and changing kernel identities', () => {
  for (const change of [{ permission: true }, { wrongNode: true }, { changed: true }]) {
    const f = missingLoopFixture(change)
    assert.throws(() => observeRecoveryLoops(f.run, f.io))
    if (change.permission) assert.equal(f.calls.filter(([command]) => command === 'mknod').length, 0)
    if (change.changed) assert.deepEqual(f.removed, [['unlink', f.alias], ['rmdir', f.directory]])
  }
})

test('a duplicate backing observed through a missing foreign node still refuses the original domain', () => {
  const f = fixture(), snapshot = captureRecoveryStorage(f.owner, f.io), original = f.io.loops
  const missing = missingLoopFixture({ duplicate: true }), rows = observeRecoveryLoops(missing.run, missing.io)
  f.io.loops = () => [...original(), { ...rows[1], 'back-ino': f.rows[0].backingInode, 'back-maj:min': '0:42' }]
  assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }), error => error.completedDomains.length === 0)
  assert.deepEqual(f.calls, [])
})

test('canonical sysfs scalars must agree with the original lost-loop observation', () => {
  const f = missingLoopFixture(), read = f.io.readFileSync
  f.io.readFileSync = path => path.endsWith('/loop/offset') ? '4096\n' : read(path)
  assert.throws(() => observeRecoveryLoops(f.run, f.io))
  assert.deepEqual(f.removed, [['unlink', f.alias], ['rmdir', f.directory]])
})
