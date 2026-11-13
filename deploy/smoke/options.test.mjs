import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readOptions } from './options.mjs'

const EMAIL = 'smoke@example.test'
const PASSWORD = 'test-only-secret-value'
const ORIGIN = 'http://127.0.0.1:32802'

test('keeps MCP outage checks disabled unless explicitly requested', async () => {
  const result = await readOptions([], { PE_CLOUD_SMOKE_EMAIL: EMAIL, PE_CLOUD_SMOKE_PASSWORD: PASSWORD })
  assert.equal(result.mcpOffline, false)
  assert.equal(result.mcpRecover, false)
})

test('accepts the paired MCP outage and recovery checks without changing legacy MCP mode', async () => {
  const result = await readOptions(['--mcp-offline', '--mcp-recover'], {
    PE_CLOUD_SMOKE_EMAIL: EMAIL, PE_CLOUD_SMOKE_PASSWORD: PASSWORD,
  })
  assert.equal(result.mcpOffline, true)
  assert.equal(result.mcpRecover, true)
  assert.equal(result.mcp, false)
})

test('refuses recovery without its same-run outage before reading credentials', async () => {
  await assert.rejects(readOptions(['--mcp-recover'], {}), /必须与同轮 --mcp-offline/)
})

test('MCP host is explicit only for optional outage checks and invalid hosts fail before credential reads', async () => {
  const credentials = { PE_CLOUD_SMOKE_EMAIL: EMAIL, PE_CLOUD_SMOKE_PASSWORD: PASSWORD }
  const original = await readOptions([], { ...credentials, PE_CLOUD_SMOKE_MCP_HOST: '0.0.0.0' })
  assert.equal(Object.hasOwn(original, 'mcpHost'), false)
  const selected = await readOptions(['--mcp-offline'], { ...credentials, PE_CLOUD_SMOKE_MCP_HOST: '127.0.0.1' })
  assert.equal(selected.mcpHost, '127.0.0.1')
  await assert.rejects(readOptions(['--mcp-offline', '--credentials', '/missing/private.json'],
    { PE_CLOUD_SMOKE_MCP_HOST: '0.0.0.0' }), /MCP 测试服务地址必须/)
})

async function withCredentials(data, run, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'pe-cloud-smoke-options-'))
  try {
    const path = join(directory, 'account.json')
    await writeFile(path, JSON.stringify(data), { mode })
    await chmod(path, mode)
    await run(path, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('reads the existing candidate credential structure and default account', async () => {
  await withCredentials({ publicOrigin: `${ORIGIN}/`, ordinaryUserC: { email: EMAIL, password: PASSWORD } }, async path => {
    assert.deepEqual(await readOptions(['--credentials', path], {}), {
      url: ORIGIN, email: EMAIL, password: PASSWORD, mcp: false, mcpOffline: false, mcpRecover: false,
      research: false, wrongPassword: false, help: false,
      continueSession: undefined, continueMarker: undefined,
    })
  })
})

test('selects a named account or a direct account without reading environment secrets', async () => {
  await withCredentials({ administrator: { email: EMAIL, password: PASSWORD } }, async path => {
    const result = await readOptions(['--credentials', path, '--account', 'administrator'], {})
    assert.equal(result.password, PASSWORD)
  })
  await withCredentials({ email: EMAIL, password: PASSWORD }, async path => {
    const result = await readOptions(['--credentials', path], { PE_CLOUD_SMOKE_PASSWORD: 'ignored' })
    assert.equal(result.email, EMAIL)
    assert.equal(result.password, PASSWORD)
  })
})

test('reads environment credentials with the selected entry and optional checks', async () => {
  const result = await readOptions(['--url', 'https://candidate.example.test/', '--mcp', '--research'], {
    PE_CLOUD_SMOKE_EMAIL: EMAIL, PE_CLOUD_SMOKE_PASSWORD: PASSWORD,
  })
  assert.equal(result.url, 'https://candidate.example.test')
  assert.equal(result.email, EMAIL)
  assert.equal(result.password, PASSWORD)
  assert.equal(result.mcp, true)
  assert.equal(result.research, true)
})

test('accepts the complete old-session row key and its original response marker together', async () => {
  const session = 'session:session-fixture-before-update'
  const marker = 'fixture-before-update-CHAT'
  const result = await readOptions(['--continue-session', session, '--continue-marker', marker], {
    PE_CLOUD_SMOKE_EMAIL: EMAIL, PE_CLOUD_SMOKE_PASSWORD: PASSWORD,
  })
  assert.equal(result.continueSession, session)
  assert.equal(result.continueMarker, marker)
})

test('refuses either old-session fixture argument without its pair', async () => {
  await assert.rejects(readOptions(['--continue-session', 'session:session-fixture'], {}), /必须成对提供/)
  await assert.rejects(readOptions(['--continue-marker', 'fixture-CHAT'], {}), /必须成对提供/)
})

test('refuses an incomplete session key or an empty history marker', async () => {
  const credentials = { PE_CLOUD_SMOKE_EMAIL: EMAIL, PE_CLOUD_SMOKE_PASSWORD: PASSWORD }
  for (const session of ['session:', 'session-fixture', 'session:session-"invalid']) {
    await assert.rejects(readOptions(['--continue-session', session, '--continue-marker', 'fixture-CHAT'], credentials), /完整的 session:/)
  }
  await assert.rejects(readOptions(['--continue-session', 'session:session-fixture', '--continue-marker', '   '], credentials), /标记不能为空/)
})

test('refuses group-readable credentials before using their contents', async () => {
  await withCredentials({ email: EMAIL, password: PASSWORD }, async path => {
    await assert.rejects(readOptions(['--credentials', path], {}), /权限为 0600/)
  }, 0o640)
})

test('refuses directories and symbolic links as credentials', async () => {
  await withCredentials({ email: EMAIL, password: PASSWORD }, async (path, directory) => {
    await assert.rejects(readOptions(['--credentials', directory], {}), /JSON 普通文件/)
    const link = join(directory, 'linked.json')
    await symlink(path, link)
    await assert.rejects(readOptions(['--credentials', link], {}), /JSON 普通文件/)
  })
})

test('refuses credentials for a different origin while allowing a matching origin path', async () => {
  await withCredentials({ publicOrigin: 'http://127.0.0.1:32803', email: EMAIL, password: PASSWORD }, async path => {
    await assert.rejects(readOptions(['--credentials', path], {}), /入口不一致/)
  })
  await withCredentials({ publicOrigin: `${ORIGIN}/login`, email: EMAIL, password: PASSWORD }, async path => {
    const result = await readOptions(['--credentials', path], {})
    assert.equal(result.password, PASSWORD)
  })
})

test('wrong-password mode generates a nonempty password different from the real password', async () => {
  const result = await readOptions(['--wrong-password'], {
    PE_CLOUD_SMOKE_EMAIL: EMAIL, PE_CLOUD_SMOKE_PASSWORD: PASSWORD,
  })
  assert.equal(result.wrongPassword, true)
  assert.notEqual(result.password, PASSWORD)
  assert.ok(result.password.length > 0)
  assert.equal(result.password.includes(PASSWORD), false)
})

test('help never reads credentials or needs account secrets', async () => {
  const result = await readOptions(['--help', '--credentials', '/missing/private/account.json'], {})
  assert.equal(result.help, true)
  assert.equal(result.email, '')
  assert.equal(result.password, '')
})

test('refuses unknown arguments, missing values, invalid URLs and incomplete accounts', async () => {
  await assert.rejects(readOptions(['--unknown'], {}), /不支持的参数/)
  await assert.rejects(readOptions(['--url', '--mcp'], {}), /缺少取值/)
  await assert.rejects(readOptions(['--url', 'file:///tmp/account.json'], {}), /HTTP 或 HTTPS/)
  await assert.rejects(readOptions([], { PE_CLOUD_SMOKE_EMAIL: EMAIL }), /完整的测试账号/)
  await withCredentials({ administrator: { email: EMAIL, password: PASSWORD } }, async path => {
    await assert.rejects(readOptions(['--credentials', path], {}), /完整的测试账号/)
  })
})

test('credential and argument errors omit secret values and raw file contents', async () => {
  await withCredentials({ email: EMAIL, password: PASSWORD }, async path => {
    await writeFile(path, `invalid-json ${EMAIL} ${PASSWORD}`)
    await assert.rejects(readOptions(['--credentials', path], {}), error => {
      assert.equal(error.message.includes(EMAIL), false)
      assert.equal(error.message.includes(PASSWORD), false)
      assert.equal(error.message.includes('invalid-json'), false)
      assert.equal(error.message.includes(path), false)
      return true
    })
  })
  await assert.rejects(readOptions([PASSWORD], {}), error => {
    assert.equal(error.message.includes(PASSWORD), false)
    return true
  })
  await assert.rejects(readOptions(['--url', `http://${EMAIL}:${PASSWORD}@example.test`], {}), error => {
    assert.equal(error.message.includes(EMAIL), false)
    assert.equal(error.message.includes(PASSWORD), false)
    return true
  })
})
