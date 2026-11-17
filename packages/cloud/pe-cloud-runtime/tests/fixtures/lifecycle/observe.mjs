/** Test-only readiness projection on the original native WebServer and launcher. */
export const inject = ['peAccountRuntime', 'webServer']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ready', handler(_req, res) {
    res.writeHead(ctx.peAccountRuntime.singleInstanceActive ? 200 : 503)
    res.end()
  } }), 'test readiness route')
  ctx.root.get('appReady').onReady(() => {
    process.stdout.write('LIFECYCLE_READY=' + ctx.webServer.port + '\n')
  })
  ctx.effect(() => () => { process.stdout.write('LIFECYCLE_DISPOSED\n') }, 'observe actual disposal')
}
