import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureRecoveryStorage, restoreRecoveryStorage } from './recovery-storage.mjs'

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
      return { name, 'back-file': row.image, ro: row.readOnly === true } }),
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
  f.io.loops = () => originalLoops().map(row => row.name === '/dev/loop80' ? { ...row, 'back-file': '/foreign.ext4' } : row)
  assert.throws(() => restoreRecoveryStorage(snapshot, { io: f.io }), error => error.completedDomains.length === 0)
  assert.deepEqual(f.calls, [])
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
  for (const conflict of [rows => rows[0]['back-file'] = '/foreign.ext4', rows => rows.push({ ...rows[0], name: '/dev/loop999' })]) {
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
