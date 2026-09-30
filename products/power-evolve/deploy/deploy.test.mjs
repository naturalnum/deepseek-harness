import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { renderProfile } from './start.mjs'
import { buildManifests, render } from './render.mjs'
import { validateBundle, readyValues } from './preflight.mjs'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))
const values = JSON.parse(await readFile(new URL('./values.example.json', import.meta.url), 'utf8'))

test('production profiles retain bundle fields and separate Host and Platform authority', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pe-s7d-profile-'))
  try {
    const env = { PE_HOST_PUBLIC_ORIGIN: values.hostPublicOrigin,
      PE_PLATFORM_PUBLIC_ORIGIN: values.platformPublicOrigin,
      PE_PLATFORM_INTERNAL_URL: `http://power-evolve-platform.${values.namespace}.svc.cluster.local:18881`,
      PE_SANDBOX_NAMESPACE: values.runnerNamespace,
      PE_SANDBOX_IMAGE: values.sandboxImage,
      PE_SANDBOX_VOLUME_CLAIM: values.storage.runnerClaim,
      PE_MODEL_URL: values.modelUrl, PE_CONNECTOR_URL: values.connectorUrl }
    for (const role of ['host', 'platform']) {
      const { profile } = await renderProfile(role, env, join(home, role))
      const rows = yaml.load(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'),
        { schema: manifestSchema })
      assert.equal(rows.length, role === 'host' ? 3 : 2)
      assert.equal(rows[0].config.host, '0.0.0.0')
      if (role === 'host') {
        assert.equal(rows[1].config.platformUrl, env.PE_PLATFORM_INTERNAL_URL)
        assert.equal(rows[2].config.origin, values.hostPublicOrigin)
        assert.equal(rows[2].config.platformOrigin, values.platformPublicOrigin)
        assert.equal(JSON.stringify(rows).includes('databaseUrlFile'), false)
      } else {
        const config = rows[1].config
        assert.equal(config.sandboxKubeconfigFile, 'in-cluster')
        assert.equal(config.sandboxNodeRoot, '')
        assert.equal(config.sandboxVolumeClaimName, values.storage.runnerClaim)
        assert.equal(config.workspaceRoot, '/data/workspaces')
        assert.equal(config.skillLibraryRoot, config.sandboxLocalRoot)
        assert.equal(config.skillLibraryRoot, '/data')
        assert.equal(config.preinstalledSkills.length, 9)
        assert.equal(config.modelUrl, values.modelUrl)
        assert.equal(config.remoteMcpConfigFile, '')
      }
    }
    for (const role of ['host', 'platform']) {
      const configured = { ...env, PE_REMOTE_MCP_CONFIG_FILE: '/run/private/remote-mcp.json' }
      const { profile } = await renderProfile(role, configured, join(home, `${role}-mcp`))
      const rows = yaml.load(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), { schema: manifestSchema })
      if (role === 'platform') assert.equal(rows[1].config.remoteMcpConfigFile, configured.PE_REMOTE_MCP_CONFIG_FILE)
      else assert(!JSON.stringify(rows).includes('remote-mcp.json'))
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('sample bundle is parseable and rejects Host privilege or mount drift', () => {
  const items = buildManifests(values)
  assert.equal(validateBundle(values, items).resources, 23)
  const platform = items.find(item => item.kind === 'Deployment'
    && item.metadata.name === 'power-evolve-platform')
  assert.equal(platform.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/health')
  assert.equal(platform.spec.template.spec.containers[0].livenessProbe.httpGet.path, '/live')
  const foundation = yaml.loadAll(render(values, 'foundation')).filter(Boolean)
  const workloads = yaml.loadAll(render(values, 'workloads')).filter(Boolean)
  assert.equal(foundation.length + workloads.length, items.length)
  assert.equal(foundation.some(item => item.kind === 'Deployment' || item.kind === 'Ingress'), false)
  assert.equal(workloads.some(item => item.kind === 'Deployment'), true)
  const host = items.find(item => item.kind === 'Deployment' && item.metadata.name === 'power-evolve-host')
  host.spec.template.spec.volumes.push({ name: 'forbidden', persistentVolumeClaim: {
    claimName: values.storage.platformClaim } })
  assert.throws(() => validateBundle(values, items), /Host must not mount/u)
  assert.throws(() => readyValues(values), /Replace example/u)
})
