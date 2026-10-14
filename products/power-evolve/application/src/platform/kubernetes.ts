/** Minimal Kubernetes HTTPS client for the pinned Agent Sandbox API and service proxy. */
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import yaml from 'js-yaml'
import { z } from 'zod'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { proxyRuntimeUpgrade } from '../runtime-upgrade-proxy.ts'

/** Two 64 KiB Sandbox streams or 128 KiB aggregate SSH output can expand sixfold in JSON. */
export const RUNNER_RESPONSE_MAX_BYTES = 1_048_576

const named = <T extends z.ZodType>(value: T) => z.array(z.object({ name: z.string(), cluster: value.optional(),
  context: value.optional(), user: value.optional() }).loose())
const kubeconfig = z.object({
  'current-context': z.string(),
  clusters: named(z.object({ server: z.url(), 'certificate-authority-data': z.string().optional() }).loose()),
  contexts: named(z.object({ cluster: z.string(), user: z.string() }).loose()),
  users: named(z.object({ 'client-certificate-data': z.string().optional(), 'client-key-data': z.string().optional(),
    token: z.string().optional() }).loose()),
}).loose()

/** HTTP failure returned by Kubernetes; transport and response-decoding failures retain their original errors. */
export class KubernetesError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** Uses one explicit kubeconfig context; credential plugins and insecure TLS are refused. */
export class KubernetesClient {
  private constructor(private readonly server: URL, private readonly ca: Buffer | undefined,
    private readonly cert: Buffer | undefined, private readonly key: Buffer | undefined,
    private readonly token: string | undefined, private readonly tokenFile?: string) {}

  /**
   * Load one explicit context or the projected in-cluster service account without credential plugins.
   * @param path Kubeconfig file path, or in-cluster for the standard projected service account files.
   * @returns TLS-verified client using the selected static credentials or rotating projected token.
   */
  static async fromFile(path: string): Promise<KubernetesClient> {
    if (path === 'in-cluster') {
      const host = process.env.KUBERNETES_SERVICE_HOST
      const port = Number(process.env.KUBERNETES_SERVICE_PORT)
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Kubernetes in-cluster service is unavailable')
      }
      const authority = host.includes(':') ? `[${host}]` : host
      return this.fromServiceAccount(`https://${authority}:${port}`,
        '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
        '/var/run/secrets/kubernetes.io/serviceaccount/token')
    }
    const config = kubeconfig.parse(yaml.load(await readFile(path, 'utf8')))
    const current = config.contexts.find(item => item.name === config['current-context'])?.context
    const cluster = config.clusters.find(item => item.name === current?.cluster)?.cluster
    const user = config.users.find(item => item.name === current?.user)?.user
    if (!current || !cluster || !user || (!user.token && !(user['client-certificate-data'] && user['client-key-data']))) {
      throw new Error('Unsupported Kubernetes credential configuration')
    }
    const server = new URL(cluster.server)
    if (server.protocol !== 'https:' || !cluster['certificate-authority-data']) throw new Error('Kubernetes TLS CA is required')
    return new KubernetesClient(server, Buffer.from(cluster['certificate-authority-data'], 'base64'),
      user['client-certificate-data'] ? Buffer.from(user['client-certificate-data'], 'base64') : undefined,
      user['client-key-data'] ? Buffer.from(user['client-key-data'], 'base64') : undefined, user.token)
  }

  /**
   * Read the rotating projected token for every request; no long-lived token copy is retained.
   * @param serverUrl Exact HTTPS Kubernetes origin without credentials, query or fragment.
   * @param caPath Trusted CA certificate file.
   * @param tokenPath Projected service account token file, read again for each request.
   * @returns TLS-verified client after both credential files have been checked.
   */
  static async fromServiceAccount(serverUrl: string, caPath: string, tokenPath: string): Promise<KubernetesClient> {
    const server = new URL(serverUrl)
    if (server.protocol !== 'https:' || server.pathname !== '/' || server.search || server.hash
      || server.username || server.password) throw new Error('Invalid Kubernetes service URL')
    const ca = await readFile(caPath)
    if (!ca.length || !(await readFile(tokenPath, 'utf8')).trim()) {
      throw new Error('Kubernetes service account credentials are unavailable')
    }
    return new KubernetesClient(server, ca, undefined, undefined, undefined, tokenPath)
  }

  /**
   * Read one bounded JSON response; transport failure or an incomplete body rejects.
   * Oversized and timed-out requests reject before their connection is destroyed.
   * @param method Kubernetes or Runner HTTP method.
   * @param path Path resolved only against the configured Kubernetes origin.
   * @param body Optional JSON request payload.
   * @param timeoutMs Maximum elapsed request and response time in milliseconds.
   * @param runnerToken Optional token for the separate Runner authorization boundary.
   * @param maxResponseBytes Positive whole-response byte ceiling; resource reads default to 256 KiB and Runner callers select
   * their protocol budget.
   * @param proxyHeaders Platform-owned browser authorization and Origin passed to a native process.
   * @returns Parsed JSON after request cleanup; the consumer validates resource or Runner fields.
   */
  async call<T>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown,
    timeoutMs = 10_000, runnerToken?: string,
    maxResponseBytes: number = 262_144,
    proxyHeaders?: { 'x-power-evolve-browser-token'?: string; origin?: string }): Promise<T> {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new TypeError('Kubernetes response budget invalid')
    const token = this.tokenFile ? (await readFile(this.tokenFile, 'utf8')).trim() : this.token
    if (!token && !this.cert) throw new Error('Kubernetes service account token is unavailable')
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const url = new URL(path, this.server)
    if (url.origin !== this.server.origin) throw new Error('Kubernetes request origin changed')
    return new Promise<T>((resolve, reject) => {
      let response: IncomingMessage | undefined
      let result: { ok: true; value: T } | { ok: false; error: Error } | undefined
      let requestClosed = false, responseClosed = true, settled = false
      const settle = (): void => {
        if (settled || !result || !requestClosed || !responseClosed) return
        settled = true
        clearTimeout(timer)
        if (result.ok) resolve(result.value)
        else reject(result.error)
      }
      const fail = (error: Error): void => {
        result ??= { ok: false, error }
        clearTimeout(timer)
        response?.destroy(); request.destroy()
        settle()
      }
      const request = httpsRequest(url, {
        method, ca: this.ca, cert: this.cert, key: this.key, rejectUnauthorized: true,
        headers: { ...proxyHeaders, accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(runnerToken === undefined ? {} : { 'x-power-evolve-runner-token': runnerToken }),
          ...(payload === undefined ? {} : { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
            'content-length': Buffer.byteLength(payload) }) },
      }, (incoming) => {
        response = incoming; responseClosed = incoming.closed
        const chunks: Buffer[] = []; let size = 0
        incoming.once('error', fail)
        incoming.once('aborted', () => { fail(new Error('Kubernetes response aborted')) })
        incoming.once('close', () => {
          responseClosed = true
          if (!incoming.complete && !result) fail(new Error('Kubernetes response closed before completion'))
          settle()
        })
        if (result) { incoming.destroy(); return }
        incoming.on('data', (chunk: Buffer) => {
          if (result) return
          size += chunk.length
          if (size > maxResponseBytes) { fail(new Error('Kubernetes response exceeds limit')); return }
          chunks.push(chunk)
        })
        incoming.once('end', () => {
          if (result) return
          const raw = Buffer.concat(chunks).toString('utf8')
          if ((incoming.statusCode ?? 500) >= 400) {
            result = { ok: false, error: new KubernetesError(incoming.statusCode ?? 500,
              `Kubernetes ${method} ${path} returned ${incoming.statusCode}`) }
          } else {
            try { result = { ok: true, value: (raw ? JSON.parse(raw) : null) as T } }
            catch (error) { result = { ok: false, error: error instanceof Error ? error
              : new Error('Kubernetes response JSON invalid', { cause: error }) } }
          }
          settle()
        })
      })
      request.once('close', () => { requestClosed = true; settle() })
      request.once('error', fail)
      const timer = setTimeout(() => { fail(new Error('Kubernetes request timed out')) }, timeoutMs)
      if (payload !== undefined) request.write(payload)
      request.end()
    })
  }

  /** Forward an admitted native stream through the credentialed Kubernetes service proxy.
   * @param request Original WebSocket handshake.
   * @param socket Admitted downstream transport.
   * @param head Already-received stream bytes.
   * @param path Server-selected namespaced service proxy path.
   * @param processToken Exact selected account process token.
   * @param browserToken Original Agent bearer, rechecked by the account process.
   * @param origin Configured public Host origin.
   * @param timeoutMs Handshake deadline.
   * @returns Completion after both stream transports close.
   */
  async proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, path: string,
    processToken: string, browserToken: string, origin: string, timeoutMs: number): Promise<void> {
    const url = new URL(path, this.server)
    if (url.origin !== this.server.origin) throw new Error('Kubernetes stream origin changed')
    const token = this.tokenFile ? (await readFile(this.tokenFile, 'utf8')).trim() : this.token
    if (!token && !this.cert) throw new Error('Kubernetes service account token is unavailable')
    await proxyRuntimeUpgrade(request, socket, head, url, {
      ca: this.ca, cert: this.cert, key: this.key, rejectUnauthorized: true,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-power-evolve-runner-token': processToken, 'x-power-evolve-browser-token': browserToken, origin },
    }, timeoutMs)
  }

  /**
   * Build the namespaced path for the pinned Sandbox API or native Kubernetes resources.
   * @param namespace Namespace owning the resource.
   * @param resource Supported Kubernetes resource kind.
   * @param name Optional exact resource name; omission selects its collection.
   * @returns URL path with encoded namespace and resource name.
   */
  resourcePath(namespace: string, resource: 'sandboxes' | 'pods' | 'services' | 'secrets', name?: string): string {
    const prefix = resource === 'sandboxes' ? '/apis/agents.x-k8s.io/v1beta1' : '/api/v1'
    return `${prefix}/namespaces/${encodeURIComponent(namespace)}/${resource}${name ? `/${encodeURIComponent(name)}` : ''}`
  }

  /**
   * Address the Runner through its namespaced Kubernetes service proxy.
   * @param namespace Namespace owning the service.
   * @param service Exact Runner service name.
   * @param path Absolute Runner request path.
   * @returns Kubernetes service-proxy URL path for the Runner's fixed HTTP port.
   */
  proxyPath(namespace: string, service: string, path: string): string {
    if (!path.startsWith('/')) throw new Error('Invalid Sandbox runner path')
    return `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/http:${encodeURIComponent(service)}:8080/proxy${path}`
  }
}
