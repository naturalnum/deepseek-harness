/** Minimal Kubernetes HTTPS client for the pinned Agent Sandbox API and service proxy. */
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import yaml from 'js-yaml'
import { z } from 'zod'

/** Two 64 KiB Sandbox streams or 128 KiB aggregate SSH output can expand sixfold in JSON. */
export const RUNNER_RESPONSE_MAX_BYTES = 1_048_576

const named = <T extends z.ZodType>(value: T) => z.array(z.object({ name: z.string(), cluster: value.optional(),
  context: value.optional(), user: value.optional() }).passthrough())
const kubeconfig = z.object({
  'current-context': z.string(),
  clusters: named(z.object({ server: z.url(), 'certificate-authority-data': z.string().optional() }).passthrough()),
  contexts: named(z.object({ cluster: z.string(), user: z.string() }).passthrough()),
  users: named(z.object({ 'client-certificate-data': z.string().optional(), 'client-key-data': z.string().optional(),
    token: z.string().optional() }).passthrough()),
}).passthrough()

export class KubernetesError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** Uses one explicit kubeconfig context; credential plugins and insecure TLS are refused. */
export class KubernetesClient {
  private constructor(private readonly server: URL, private readonly ca: Buffer | undefined,
    private readonly cert: Buffer | undefined, private readonly key: Buffer | undefined,
    private readonly token: string | undefined, private readonly tokenFile?: string) {}

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

  /** Read the rotating projected token for every request; no long-lived token copy is retained. */
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
   * @param timeoutMs Socket inactivity deadline in milliseconds.
   * @param runnerToken Optional token for the separate Runner authorization boundary.
   * @param maxResponseBytes Positive whole-response byte ceiling; resource reads default to 256 KiB and Runner callers select their protocol budget.
   * @returns Parsed JSON whose resource or Runner shape must be validated by the consumer.
   */
  async call<T>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown,
    timeoutMs = 10_000, runnerToken?: string,
    maxResponseBytes: number = 262_144): Promise<T> {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new TypeError('Kubernetes response budget invalid')
    const token = this.tokenFile ? (await readFile(this.tokenFile, 'utf8')).trim() : this.token
    if (!token && !this.cert) throw new Error('Kubernetes service account token is unavailable')
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const url = new URL(path, this.server)
    if (url.origin !== this.server.origin) throw new Error('Kubernetes request origin changed')
    return new Promise<T>((resolve, reject) => {
      const request = httpsRequest(url, {
        method, ca: this.ca, cert: this.cert, key: this.key, rejectUnauthorized: true,
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(runnerToken === undefined ? {} : { 'x-power-evolve-runner-token': runnerToken }),
          ...(payload === undefined ? {} : { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
            'content-length': Buffer.byteLength(payload) }) },
        timeout: timeoutMs,
      }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.once('error', reject)
        response.once('aborted', () => reject(new Error('Kubernetes response aborted')))
        response.once('close', () => {
          if (!response.complete) reject(new Error('Kubernetes response closed before completion'))
        })
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxResponseBytes) {
            const error = new Error('Kubernetes response exceeds limit')
            reject(error)
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.once('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if ((response.statusCode ?? 500) >= 400) {
            reject(new KubernetesError(response.statusCode ?? 500, `Kubernetes ${method} ${path} returned ${response.statusCode}`)); return
          }
          try { resolve((raw ? JSON.parse(raw) : null) as T) } catch (error) { reject(error) }
        })
      })
      request.once('timeout', () => {
        const error = new Error('Kubernetes request timed out')
        reject(error)
        request.destroy()
      })
      request.once('error', reject)
      if (payload !== undefined) request.write(payload)
      request.end()
    })
  }

  resourcePath(namespace: string, resource: 'sandboxes' | 'pods' | 'services' | 'secrets', name?: string): string {
    const prefix = resource === 'sandboxes' ? '/apis/agents.x-k8s.io/v1beta1' : '/api/v1'
    return `${prefix}/namespaces/${encodeURIComponent(namespace)}/${resource}${name ? `/${encodeURIComponent(name)}` : ''}`
  }

  proxyPath(namespace: string, service: string, path: string): string {
    if (!path.startsWith('/')) throw new Error('Invalid Sandbox runner path')
    return `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/http:${encodeURIComponent(service)}:8080/proxy${path}`
  }
}
