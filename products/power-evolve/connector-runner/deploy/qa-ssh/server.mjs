/** Fixed-response SSH target for the disposable k3d Connector Runner check. */
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import ssh2 from 'ssh2'

const directory = '/run/power-evolve/qa-ssh'
const [hostKey, password] = await Promise.all([
  readFile(`${directory}/host-key`), readFile(`${directory}/password`, 'utf8'),
])
const equal = (candidate) => {
  const actual = Buffer.from(candidate), expected = Buffer.from(password)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (context) => {
    if (context.method === 'password' && context.username === 'qa'
      && equal(context.password)) context.accept()
    else context.reject()
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, rejectExec, info) => {
        if (info.command !== 'qa:ping') { rejectExec(); return }
        const stream = acceptExec()
        stream.exit(0)
        stream.end('qa:ssh-ok\n')
      })
    })
  })
})
server.listen(2222, '0.0.0.0')
