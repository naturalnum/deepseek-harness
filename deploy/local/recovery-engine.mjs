/** Bind the same bounded recovery transport either directly or through an existing owned backend Engine. */
import { pathToFileURL } from 'node:url'
import { createRecoveryTransport, RecoveryTransportError } from './recovery-transport.mjs'

/**
 * Use one explicit carrier Engine, optionally reached through its already running local backend container.
 * @param {object} options Original transport options; via names the owned outer backend, its Node/relay paths,
 * and actual inner Docker/socket paths. No container, port forward, daemon or temporary Engine is created.
 * @returns {object} Same request/runDocker/inspectExec/state/close interface. Outer client exit never confirms
 * inner exec exit. Cancellation/unknown fences every later call and retains both original responsibilities.
 */
export function createRecoveryEngine(options) {
  if (options.via === undefined) return createRecoveryTransport(options)
  const via = options.via
  if (!via || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(via.container)
    || ['nodePath', 'relayEntry', 'socketPath', 'dockerPath'].some(key => typeof via[key] !== 'string' || !via[key].startsWith('/') || via[key].includes('\0'))) {
    throw new RecoveryTransportError(false)
  }
  const outer = createRecoveryTransport({ ...options, container: via.container })
  let unknown = false
  const relay = async action => {
    if (unknown) throw new RecoveryTransportError(true)
    try {
      return JSON.parse(await outer.runDocker(['exec', '--interactive', '--user', '0', via.container,
        via.nodePath, via.relayEntry, '--relay'], { input: JSON.stringify({
        socketPath: via.socketPath, dockerPath: via.dockerPath, container: options.container,
        budgetMs: Math.max(1, Math.floor(options.deadlineAtMs - performance.now())),
        maxOutputBytes: options.maxOutputBytes, action,
      }) }))
    } catch (_error) { unknown = true; throw new RecoveryTransportError(true) }
  }
  const request = (method, route, payload) => relay({ kind: 'request', method, route, payload })
  return {
    request,
    runDocker: (argv, settings) => relay({ kind: 'docker', argv, input: settings?.input }),
    inspectExec: id => relay({ kind: 'inspect-exec', id }),
    state: () => ({ ...outer.state(), unknown: unknown || outer.state().unknown }),
    close: () => outer.close(),
  }
}

// The relay executes only the same bounded fixed-container transport, inside the handed-over backend.
async function relayCommand() {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort())
  let transport
  try {
    const chunks = []; let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 1048576) throw new RecoveryTransportError(false)
      chunks.push(chunk)
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!Number.isSafeInteger(input.budgetMs) || input.budgetMs < 1 || input.budgetMs > 1800000) throw new RecoveryTransportError(false)
    transport = createRecoveryTransport({ ...input, signal: controller.signal, deadlineAtMs: performance.now() + input.budgetMs })
    let result
    if (input.action.kind === 'request') result = await transport.request(input.action.method, input.action.route, input.action.payload)
    else if (input.action.kind === 'docker') result = await transport.runDocker(input.action.argv, { input: input.action.input })
    else if (input.action.kind === 'inspect-exec') result = await transport.inspectExec(input.action.id)
    else throw new RecoveryTransportError(false)
    await transport.close(); transport = undefined
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (_error) {
    console.error('恢复Engine接点未确认；不重试或释放内部exec。'); process.exitCode = 1
  } finally { await transport?.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === '--relay') await relayCommand()
  else process.exitCode = 2
}
