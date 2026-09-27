/** Minimal Kubernetes HTTPS client for the pinned Agent Sandbox API and service proxy. */
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import yaml from 'js-yaml'
import { z } from 'zod'

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
    private readonly token: string | undefined) {}

  static async fromFile(path: string): Promise<KubernetesClient> {
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

  async call<T>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown,
    timeoutMs = 10_000, runnerToken?: string): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const url = new URL(path, this.server)
    if (url.origin !== this.server.origin) throw new Error('Kubernetes request origin changed')
    return new Promise<T>((resolve, reject) => {
      const request = httpsRequest(url, {
        method, ca: this.ca, cert: this.cert, key: this.key, rejectUnauthorized: true,
        headers: { accept: 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(runnerToken === undefined ? {} : { 'x-power-evolve-runner-token': runnerToken }),
          ...(payload === undefined ? {} : { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
            'content-length': Buffer.byteLength(payload) }) },
        timeout: timeoutMs,
      }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 262_144) { request.destroy(new Error('Kubernetes response exceeds limit')); return }
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
      request.once('timeout', () => request.destroy(new Error('Kubernetes request timed out')))
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
