/** Image-bound dependency queries run through an independent real Cloud account graph and Native tool. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Dependencies from '../../../skill/tool-workspace-dependencies/src/index.ts'
import { policyFixture } from './account-policy-fixture.ts'

it('returns selected guest paths without installing a Host interpreter in a real Cloud account', async () => {
  const carrier = mkdtempSync(join(tmpdir(), 'cloud-office-manifest-'))
  onTestFinished(() => rmSync(carrier, { recursive: true, force: true }))
  writeFileSync(join(carrier, 'runtime.json'), JSON.stringify({ desktopVersion: 'cloud-image-fixture', platform: 'linux',
    arch: 'amd64', python: '3.12.13', node: '22.23.2', pythonPackages: { openpyxl: '3.1.5', pandas: '2.3.3' } }))
  const owner = policyFixture([], undefined, 'office-dependencies', undefined, undefined, undefined, undefined,
    undefined, [], true, undefined, {
      defaultId: 'cloud-chat', declarations: [{ entryId: 'cloud-preset',
        config: { id: 'cloud-chat', plugins: [] }, selectable: true }],
      sourceModules: { '@deepseek-ai/dsh-tool-workspace-dependencies': Dependencies },
      extraEntries: [{ id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies',
        config: { source: '/opt/dsh/runtime', executionManifest: carrier } }],
    })
  const graph = await owner.start(), created = await graph.ctx.sessionController.create({})
  const agent = graph.ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('Native Cloud Agent was not created')
  for (const id of ['first', 'repeat']) {
    const result = await graph.ctx.tools.execute({ agent, name: 'load_workspace_dependencies', arguments: {},
      callId: ToolCallId(id), signal: graph.lifetime.signal })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({
      python: '/opt/dsh/runtime/dependencies/python/bin/python3', node: '/opt/dsh/runtime/dependencies/node/bin/node',
      nodePackages: '/opt/dsh/runtime/dependencies/node/node_modules',
      pythonPackages: '/opt/dsh/runtime/dependencies/python/lib/python3.12/site-packages',
      pythonDistributions: { openpyxl: '3.1.5', pandas: '2.3.3' },
    }, undefined, 2) }])
  }
})
