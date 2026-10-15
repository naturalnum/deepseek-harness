/** The assembled native Client consumes actual authenticated Host control and event packets together. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-session-controller']) })
const run = promisify(execFile), root = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = z.object({ oldId: z.uuid().transform(SessionId), newId: z.uuid().transform(SessionId), foreignId: z.uuid(),
  phases: z.array(z.array(z.object({ type: z.literal('item'), streamId: z.enum(['control', 'events']), value: z.json() }).strict())) }).strict()

it('keeps one control opening while new empty Sessions arrive through native events and later real cuts win',
  { timeout: 60_000 }, async ({ mock, start }) => {
    const directory = await mkdtemp(join(tmpdir(), 'pe-native-control-client-'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const path = join(directory, 'packets.json'), report = join(directory, 'wire-report.json')
      const result = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
        join(root, 'vitest.power-evolve.cloud.config.ts'), 'products/power-evolve/application/tests/native-control-baseline.spec.ts',
        '--reporter=verbose', '--reporter=json', `--outputFile=${report}`],
      { cwd: root, env: { ...process.env, PE_NATIVE_CONTROL_FIXTURE_FILE: path }, maxBuffer: 1_048_576, timeout: 30_000 })
      const value = fixture.parse(JSON.parse(await readFile(path, 'utf8')))
      const evidence = process.env['PE_NATIVE_CONTROL_EVIDENCE_DIR']
      if (evidence !== undefined) {
        await writeFile(join(evidence, 'wire-packets.json'), await readFile(path))
        await writeFile(join(evidence, 'wire-report.json'), await readFile(report))
        await writeFile(join(evidence, 'wire.log'), result.stdout + result.stderr)
      }
      mock.remote.session.list.mockResolvedValue(ok({ items: [] }))
      mock.stream('session/control', (_args, stream) => {
        for (const frame of value.phases[0] ?? []) if (frame.streamId === 'control') stream.push(frame.value)
      })
      mock.stream('$events', (_args, stream) => {
        for (const frame of value.phases[0] ?? []) if (frame.streamId === 'events') stream.push(frame.value)
      })
      const client = await start(), sessions: ISessions = client.ctx.sessions
      await client.flush()
      const model = (id: SessionId) => sessions.list.getSnapshot().projectionsBySession[id]?.values.modelSelection
      for (const [index, [expected, preset]] of [
        ['new-model', 'coding'], ['new-model', 'coding'], ['same-cut-change', 'standard'], ['event-model', 'coding'],
      ].entries()) {
        for (const frame of value.phases[index + 1] ?? []) {
          mock.streams.push(frame.streamId === 'control' ? 'session/control' : '$events', frame.value)
        }
        await mock.streams.drained('session/control'); await mock.streams.drained('$events'); await client.flush()
        await vi.waitFor(() => { expect(model(value.newId)).toMatchObject({ next: { model: expected } }) })
        expect(sessions.list.getSnapshot().byId[value.newId]?.title).toBe(expected)
        expect(sessions.list.getSnapshot().byId[value.newId]?.projectionValues?.agentPreset).toBe(preset)
        expect(model(value.oldId)).toMatchObject({ next: { model: 'old-model' } })
        expect(sessions.list.getSnapshot().byId[SessionId(value.foreignId)]).toBeUndefined()
        expect(logged).not.toHaveBeenCalled()
      }
      expect(sessions.list.getSnapshot().byId[value.newId]?.projectionValues?.agentPreset).toBe('coding')
      expect(mock.log.streams('session/control')).toHaveLength(1)
      mock.streams.push('session/control', { type: 'baseline', value: { projections: {} } })
      await vi.waitFor(() => { expect(logged).toHaveBeenCalledWith('[session-controller] control stream failed:',
        expect.objectContaining({ message: 'session control stream emitted more than one opening snapshot' })) })
    } finally { logged.mockRestore(); await rm(directory, { recursive: true, force: true }) }
  })
