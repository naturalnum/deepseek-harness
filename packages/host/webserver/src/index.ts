/**
 * @deepseek-ai/dsh-host-webserver — node:http route registration — node:https
 * when `tls` names a certificate and key — with optional gzip, index injection,
 * and one fallback seat. It knows no harness concepts and serves no files; the
 * composing application owns dist serving. Electron uses file:// plus IPC
 * instead, and this package never prints the URL.
 * Route handlers retain direct response ownership.
 */

import { X509Certificate } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { isIP, type AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { getDefaultHighWaterMark, type Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import compressionMiddleware from 'compression'
import ipaddr from 'ipaddr.js'
import Negotiator from 'negotiator'
import { renderIndexInjections, type IndexInjection } from './injections.ts'

export { renderIndexInjections } from './injections.ts'
export type { IndexInjection, IndexInjectionPlacement } from './injections.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
  interface Events {
    /**
     * Collect the structured index injection table. Emitted on every index
     * render and every worker boot-payload request; listeners push their
     * current rows, so a row's data is read fresh at emit time.
     * @param table - Mutable row table; listeners append in activation order.
     * @mode emit
     */
    'webserver/index-inject'(table: IndexInjection[]): void
  }
}

/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/**
 * TLS material for the HTTPS listener: one certificate chain file and the
 * private key file it pairs with, plus optional client CA certificates. PEM
 * file paths resolve against the process working directory.
 */
export interface TlsConfig {
  /** Certificate chain file, leaf certificate first, PEM, no passphrase. */
  certFile: string
  /** Private key file for the chain's leaf certificate; unencrypted PEM. */
  keyFile: string
  /**
   * Request client certificates using only this CA bundle, while accepting anonymous or unauthorized TLS peers.
   * Omission/null keeps ordinary HTTPS.
   */
  clientCa?: {
    /** PEM file containing only CA certificates; paths resolve against the process working directory. */
    certFile: string
    /** Positive safe-integer file-byte limit; the reader reserves one extra byte to detect growth. */
    maxBytes: number
  }
}

/** Web server listen, TLS, and response-compression config. */
export interface Config {
  /**
   * Listen address: a concrete IPv4 or IPv6 literal of one local interface,
   * for example the container's own Pod address from `hostname -i`. A loopback
   * literal (any address in 127/8, `::1`, or a mapped form of either) keeps the
   * server on this machine; any other literal serves the network that address
   * belongs to, over plain HTTP unless `tls` is set. The unspecified address —
   * IPv4 any, IPv6 any, and the IPv4-mapped forms of IPv4 any — is rejected at
   * load: it would expose the port on every interface at once.
   */
  host: string
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /**
   * Serve HTTPS with this certificate and key instead of plain HTTP. Both files
   * are read once, before the listener binds: an unreadable or empty file,
   * invalid PEM, or a key that does not match the certificate rejects
   * initialization rather than falling back to HTTP. The material is never
   * re-read, so replacing a certificate takes a reload. Omitted or null listens
   * over plain HTTP.
   */
  tls?: TlsConfig
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
  /** Limits selected before listen; omission or null keeps defaults. TLS requires the current public default stream watermark. */
  transportLimits?: {
    /** Route-enforced pair budget; the parser retains one excess pair so routes can reject silent truncation. Maximum 0x3fff_fffe. */
    maxHeaderPairs: number
    /** Positive finite request-header byte limit, enforced by Node's parser. */
    maxHeaderBytes: number
    /** Positive finite stream high-water mark in bytes; not a hard process-memory limit. */
    highWaterMark: number
    /** Positive finite simultaneous connection limit on this listener. */
    maxConnections: number
  }
}

function assertTlsWatermark(limits: Config['transportLimits'], tls: boolean): void {
  if (tls && limits != null && limits.highWaterMark !== getDefaultHighWaterMark(false)) {
    throw new Error('webserver: TLS transportLimits.highWaterMark must equal getDefaultHighWaterMark(false); this HTTPS listener does not apply a custom stream watermark.')
  }
}

const DEFAULT_COMPRESSION = 'none' as const
const DEFAULT_COMPRESSION_LEVEL = 1
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024

interface ResolvedConfig extends Config {
  compression: 'none' | 'gzip'
  compressionLevel: number
  compressionThresholdBytes: number
}

type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void

/** Dotted-quad tail of the IPv6 mixed notation: `::0.0.0.1`, `1:2:3:4:5:6:127.0.0.1`. */
const IPV4_TAIL = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Rewrite a dotted-quad tail as the two hex groups holding the same bytes.
 * ipaddr.js 2.5.0 reads an all-zero prefix plus a quad (`::0.0.0.1`) as the
 * IPv4-mapped form `::ffff:0:1`, while `getaddrinfo` — and so `listen` — reads
 * that tail as the low 32 bits of the address itself, which makes `::0.0.0.1`
 * the loopback literal `::1`. Parsing the rewritten text keeps the parsed value
 * equal to the value the socket binds.
 */
function withHexTail(host: string): string {
  const tail = IPV4_TAIL.exec(host)
  if (tail === null) return host
  const [, head = '', a = '', b = '', c = '', d = ''] = tail
  const high = ((Number(a) << 8) | Number(b)).toString(16)
  const low = ((Number(c) << 8) | Number(d)).toString(16)
  return `${head}${high}:${low}`
}

/**
 * Parse a concrete IP literal, normalizing IPv4-mapped IPv6 to IPv4.
 * `node:net` decides what a value must look like for `listen` to accept it, and
 * a trailing `%zone` (a local interface selector, never address text) comes off
 * before parsing; the value handed to `listen` keeps its zone.
 */
function parseIpLiteral(host: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  if (isIP(host) === 0) return undefined
  const zoneAt = host.indexOf('%')
  const parsed = ipaddr.parse(withHexTail(zoneAt === -1 ? host : host.slice(0, zoneAt)))
  return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed
}

/** Rejection for a bind address that is no concrete IP literal. */
function notLiteralError(value: string): Error {
  return new Error(`webserver: host ${JSON.stringify(value)} is not a concrete IPv4 or IPv6 address literal`)
}

/** ipaddr's IPv4 unspecified range covers all of 0/8; only the all-zero address binds every interface. */
function isWildcardAddress(parsed: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  const parts = parsed instanceof ipaddr.IPv4 ? parsed.octets : parsed.parts
  return parts.every(part => part === 0)
}

/**
 * Whether a bind address requests every interface at once.
 * @param host - bind address from configuration.
 * @returns true for IPv4 any, IPv6 any, and an IPv4-mapped form of IPv4 any.
 */
export function isWildcardHost(host: string): boolean {
  const parsed = parseIpLiteral(host)
  return parsed !== undefined && isWildcardAddress(parsed)
}

/**
 * Whether a bind address names the local loopback authority.
 * @param host - bind address from configuration.
 * @returns true for any address in 127/8, `::1`, and their IPv4-mapped forms.
 */
export function isLoopbackHost(host: string): boolean {
  const parsed = parseIpLiteral(host)
  return parsed !== undefined && parsed.range() === 'loopback'
}

/**
 * Canonical text of the address a bind literal names: IPv4 and IPv4-mapped
 * literals read as dotted quad, every other literal as its compressed IPv6
 * value. The text names the address `listen` binds, so `::0.0.0.1` reads as
 * `::1`. A `%zone` selects an interface and never appears in the text.
 * @param host - concrete IPv4 or IPv6 literal, with or without a zone.
 * @returns the address text, ready to be a URL host.
 * @throws when `host` is no concrete IPv4 or IPv6 address literal.
 */
export function normalizeBindAddress(host: string): string {
  const parsed = parseIpLiteral(host)
  if (parsed === undefined) throw notLiteralError(host)
  return parsed.toString()
}

/**
 * The URL host form of a bind address. Loopback addresses use their canonical
 * text, so browsers treat them as local, trustworthy origins: a mapped literal
 * such as `::ffff:127.0.0.1` reads as `127.0.0.1`, and `::0.0.0.1` reads as
 * `::1`. A redundant loopback zone is dropped; other addresses keep their text,
 * and IPv6 text is bracketed.
 * @param host - concrete IPv4 or IPv6 bind literal.
 * @returns the URL host, or `undefined` when a non-loopback interface zone id makes the address inexpressible in a URL.
 */
export function bindUrlHost(host: string): string | undefined {
  const zoneAt = host.indexOf('%')
  const bare = zoneAt === -1 ? host : host.slice(0, zoneAt)
  if (!isLoopbackHost(bare) && zoneAt !== -1) return undefined
  const text = isLoopbackHost(bare) ? normalizeBindAddress(bare) : host
  return isIP(text) === 6 ? `[${text}]` : text
}

function createGzipMiddleware(config: ResolvedConfig): NodeMiddleware {
  // `compression` is typed for Express, but its runtime uses only the
  // node:http request and response members supplied here.
  const middleware = compressionMiddleware({
    level: config.compressionLevel,
    threshold: config.compressionThresholdBytes,
    filter(request, response) {
      if (response.getHeader('content-range') !== undefined) return false
      const contentType = response.getHeader('content-type')
      if (typeof contentType === 'string' && contentType.toLowerCase().startsWith('text/event-stream')) return false
      if (typeof contentType === 'string' && /^multipart\/form-data(?:;|$)/i.test(contentType)) return true
      return compressionMiddleware.filter(request, response)
    },
  }) as NodeMiddleware

  return (req, res, next) => {
    // The Web Worker tunnel has no socket and transfers identity bytes.
    if ((res as { socket?: unknown }).socket === undefined) {
      next()
      return
    }
    const encoding = new Negotiator(req).encoding(['gzip', 'identity'])
    const gzipRequest = Object.create(req) as IncomingMessage
    Object.defineProperty(gzipRequest, 'headers', {
      value: { ...req.headers, 'accept-encoding': encoding === 'gzip' ? 'gzip' : 'identity' },
    })
    middleware(gzipRequest, res, next)
  }
}

/**
 * Read one TLS material file for activation. The error names the config field
 * and the resolved path; empty content is rejected here because node:tls
 * silently accepts it, which would bind a listener that can never complete a
 * handshake.
 * @param field - the config field being read, for the diagnostic.
 * @param path - absolute path to read.
 * @param maxBytes - Optional file-byte limit plus a growth sentinel; omission preserves the original certificate/key read.
 * @returns the file's text.
 */
async function readTlsFile(field: 'certFile' | 'keyFile' | 'clientCa.certFile', path: string, maxBytes?: number): Promise<string> {
  let content: string
  try {
    if (maxBytes === undefined) content = await readFile(path, 'utf8')
    else {
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const before = await handle.stat()
        if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > maxBytes) {
          throw new Error('A regular PEM file within the configured byte limit is required')
        }
        const bytes = Buffer.alloc(before.size + 1)
        let length = 0
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
          if (bytesRead === 0) break
          length += bytesRead
        }
        const after = await handle.stat()
        if (length !== before.size || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error('The PEM file changed during its bounded read')
        }
        content = bytes.subarray(0, length).toString('utf8')
      } finally { await handle.close() }
    }
  } catch (error) {
    throw new Error(`webserver: cannot read tls.${field} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (content.trim().length === 0) {
    throw new Error(`webserver: tls.${field} ${path} is empty`)
  }
  return content
}

function validateClientCa(content: string, path: string): string {
  // Node's CA loader can ignore malformed input instead of rejecting initialization.
  const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu
  const certificates = content.match(pem)
  try {
    if (certificates === null || content.replace(pem, '').trim() !== ''
      || certificates.some(certificate => !new X509Certificate(certificate).ca)) {
      throw new Error('Only CA certificate PEM blocks are allowed')
    }
  } catch (error) {
    throw new Error(`webserver: tls.clientCa.certFile ${path} is not a usable CA certificate bundle`, { cause: error })
  }
  return content
}

/**
 * The browser HTTP carrier service. Activation loads any configured TLS
 * material, then listens immediately; a material or listen failure rejects
 * initialization, and the boot process reports the failed fiber. Route
 * registration order does not affect requests because configured named routes
 * must be distinct, and the fallback handler answers anything not yet claimed
 * during startup with 404 until its owner registers.
 */
export class WebServer extends Service {
  static Config: z<Config> = z.object({
    host: z.transform(z.string(), (value) => {
      const parsed = parseIpLiteral(value)
      if (parsed === undefined) throw notLiteralError(value)
      if (isWildcardAddress(parsed)) {
        throw new Error(`webserver: host ${JSON.stringify(value)} is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address of a local interface instead`)
      }
      return value
    }).required(),
    port: z.natural().max(65535).required(),
    // An omitted object must not become `{}` and fail the required pair fields.
    tls: z.object({
      certFile: z.string().required(),
      keyFile: z.string().required(),
      clientCa: z.union([z.object({
        certFile: z.string().required(),
        maxBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER - 1).required(),
      }).required()]),
    }).default(undefined as never),
    compression: z.union([z.const('none'), z.const('gzip')]).default(DEFAULT_COMPRESSION),
    compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
    compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES),
    transportLimits: z.union([z.object({
      maxHeaderPairs: z.natural().min(1).max(0x3fff_fffe).required(),
      maxHeaderBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
      highWaterMark: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
      maxConnections: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
    }).required()]),
  })

  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private readonly upgradedSockets = new Set<Duplex>()
  /**
   * Raw connections of a TLS listener, held until they close. A TLS connection
   * joins closeAllConnections()'s table only once its handshake completes, so a
   * socket still handshaking — or one whose peer never sends a ClientHello —
   * would otherwise keep `close()` waiting on the TLS handshake timeout. Empty
   * for the plain listener, whose connections closeAllConnections() reaches.
   */
  private readonly tlsConnections = new Set<Duplex>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: WebRoute['handler'] | undefined
  private server!: Server
  private listenedPort: number | undefined
  private readonly gzip: NodeMiddleware | undefined
  private readonly tlsConfig: TlsConfig | undefined

  constructor(ctx: Context, private config: Config) {
    const resolved = config as ResolvedConfig
    assertTlsWatermark(resolved.transportLimits, resolved.tls != null)
    super(ctx, 'webServer')
    // Schemastery passes an explicit `tls: null` through; only a real object serves TLS.
    this.tlsConfig = resolved.tls ?? undefined
    this.gzip = resolved.compression === 'gzip' ? createGzipMiddleware(resolved) : undefined
  }

  /** The listening port (the OS-assigned value when config.port is 0), or `undefined` before `listen` binds. */
  get port(): number | undefined {
    return this.listenedPort
  }

  /** The configured bind address (one concrete local interface). */
  get host(): Config['host'] {
    return this.config.host
  }

  /**
   * The protocol the listener speaks: `'https:'` when `tls` is configured. The
   * value follows configuration, never a socket or a request header, so a
   * consumer reads it before any request and no proxy can change it.
   */
  get protocol(): 'http:' | 'https:' {
    return this.tlsConfig === undefined ? 'http:' : 'https:'
  }

  /**
   * The root URL local clients use to reach the bound listener: the protocol,
   * the {@link bindUrlHost} form of the bind address, and the listening port.
   * @returns the origin, for example `http://127.0.0.1:3080`.
   * @throws before `listen` binds a port, or when the bind address has no URL form.
   */
  getOrigin(): string {
    const host = bindUrlHost(this.config.host)
    if (host === undefined) {
      throw new Error(`webserver: bind address ${JSON.stringify(this.config.host)} carries an interface zone id, which no URL can express`)
    }
    if (this.listenedPort === undefined) throw new Error('webserver: origin read before the listener bound a port')
    return `${this.protocol}//${host}:${String(this.listenedPort)}`
  }

  /**
   * Register a named route. Duplicate (kind, path) throws — route patterns are
   * a composition-level contract, so a collision is a misconfiguration.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * Register an exact-path HTTP upgrade route. Duplicate paths throw because
   * one socket can have only one protocol owner.
   * @param route - pathname and handler owning negotiation plus socket use.
   * @returns the disposer removing the route.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /**
   * Claim the fallback seat: the handler answering every request no named
   * route matches (the SPA dist server in the shipped Web composition). One
   * owner only — a second registration throws, because two fallbacks cannot
   * compose.
   * @param handler - owns the full response lifecycle of unmatched requests.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /**
   * Register a raw-HTML index transform, the escape hatch for markup no
   * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
   * registration order after rendering the structured rows.
   * @param transform - pure html-to-html function.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
  async [Service.init](): Promise<void> {
    const tls = this.tlsConfig
    const limits = this.config.transportLimits == null ? undefined : { ...this.config.transportLimits }
    const socketWatermarksMatch = (socket: Duplex): boolean => limits === undefined
      || socket.readableHighWaterMark === limits.highWaterMark && socket.writableHighWaterMark === limits.highWaterMark
    const watermarksMatch = (req: IncomingMessage, res?: ServerResponse): boolean => limits === undefined
      || socketWatermarksMatch(req.socket) && req.readableHighWaterMark === limits.highWaterMark
      && (res === undefined || res.writableHighWaterMark === limits.highWaterMark)
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
      requests; the field is only optional on the client-side IncomingMessage type */
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = this.match(rawPath)
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      const fallback = this.fallback
      if (fallback === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      await fallback(req, res)
    }
    // Last-resort guard: handle() rejecting would otherwise be an unhandled
    // rejection killing the process on one malformed request (bad %-escape,
    // client dropping mid-body). Per-request failures log and answer 400 —
    // never a process exit.
    const listener = (req: IncomingMessage, res: ServerResponse): void => {
      if (!watermarksMatch(req, res)) { req.socket.destroy(); return }
      const next = (): void => {
        void handle(req, res).catch((err: unknown) => {
          this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
          if (res.headersSent) {
            res.destroy()
            return
          }
          res.writeHead(400)
          res.end()
        })
      }
      if (this.gzip === undefined) next()
      else this.gzip(req, res, next)
    }
    const options = limits === undefined ? {} : {
      maxHeaderSize: limits.maxHeaderBytes, highWaterMark: limits.highWaterMark,
    }
    // Disposal waits for in-flight acquisition and closes any listener it produces.
    await this.ctx.effect(async () => {
      if (tls === undefined) {
        this.server = createServer(options, listener)
      } else {
        const certFile = resolve(tls.certFile)
        const keyFile = resolve(tls.keyFile)
        const [cert, key] = await Promise.all([
          readTlsFile('certFile', certFile),
          readTlsFile('keyFile', keyFile),
        ])
        const clientCaPath = tls.clientCa == null ? undefined : resolve(tls.clientCa.certFile)
        const clientCa = clientCaPath === undefined || tls.clientCa == null ? undefined
          : validateClientCa(await readTlsFile('clientCa.certFile', clientCaPath, tls.clientCa.maxBytes), clientCaPath)
        assertTlsWatermark(limits, true)
        try {
          this.server = createSecureServer({ cert, key,
            ...(clientCa === undefined ? {} : { ca: clientCa, requestCert: true, rejectUnauthorized: false }),
            ...(limits === undefined ? {} : { maxHeaderSize: limits.maxHeaderBytes }) }, listener)
        } catch (error) {
          throw new Error(`webserver: tls.certFile ${certFile} and tls.keyFile ${keyFile} are not a usable certificate and key pair: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.server.on('connection', (socket) => {
          this.tlsConnections.add(socket)
          socket.once('close', () => { this.tlsConnections.delete(socket) })
        })
        if (limits !== undefined) this.server.prependListener('secureConnection', (socket: Duplex) => {
          if (!socketWatermarksMatch(socket)) socket.destroy()
        })
      }
      if (limits !== undefined) {
        // Capture a sentinel pair: routes must reject excess before interpreting or forwarding any headers.
        this.server.maxHeadersCount = limits.maxHeaderPairs + 1
        this.server.maxConnections = limits.maxConnections
        const rejectExpectation = (req: IncomingMessage, res: ServerResponse): void => {
          if (!watermarksMatch(req, res)) { req.socket.destroy(); return }
          res.writeHead(417, { connection: 'close', 'content-length': '0' })
          res.end()
        }
        this.server.on('checkContinue', rejectExpectation)
        this.server.on('checkExpectation', rejectExpectation)
      }
      this.server.on('upgrade', (req, socket, head) => {
        const onError = (error: Error): void => {
          this.ctx.logger.warn(error)
          socket.destroy()
        }
        socket.on('error', onError)
        socket.once('close', () => {
          socket.off('error', onError)
          this.upgradedSockets.delete(socket)
        })
        if (!watermarksMatch(req) || limits !== undefined && req.headers.expect !== undefined) {
          socket.destroy()
          return
        }
        let route: WebUpgradeRoute | undefined
        try {
          /* v8 ignore next -- node:http always sets url on server requests. */
          route = this.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
        } catch (error) {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
          return
        }
        if (route === undefined) {
          socket.destroy()
          return
        }
        this.upgradedSockets.add(socket)
        try {
          Promise.resolve(route.handler(req, socket, head)).catch((error: unknown) => {
            this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
            socket.destroy()
          })
        } catch (error) {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
        }
      })

      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.config.port, this.config.host, () => {
          this.server.off('error', reject)
          this.server.on('error', (err) => { this.ctx.logger.error(err) })
          this.listenedPort = (this.server.address() as AddressInfo).port
          resolve()
        })
      })

      // Node does not include upgraded sockets in closeAllConnections(), and a TLS
      // connection joins that table only after its handshake. The service owns both
      // kinds with the other connections, so it tracks and destroys them explicitly.
      return async () => {
        const serverClosed = new Promise<void>((resolve) => {
          this.server.close(() => { resolve() })
        })
        this.server.closeAllConnections()
        const socketsClosed = [...this.upgradedSockets, ...this.tlsConnections].map(socket => new Promise<void>((resolve) => {
          socket.once('close', () => { resolve() })
          socket.destroy()
        }))
        await Promise.all([serverClosed, ...socketsClosed])
      }
    }, 'webServer.listen')
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /**
   * Run an index.html body through the registered taps in registration order
   * — called by the fallback owner on every index response it renders.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /**
   * Gather the structured injection table: one `webserver/index-inject` emit,
   * every subscriber pushes its current rows. Fresh per call, so subscribers
   * read live state (module graph, theme preference) at emit time.
   * @returns rows in subscriber activation order.
   */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.ctx.emit('webserver/index-inject', table)
    return table
  }

  /**
   * Render one index.html body: the structured injection table first, then
   * the raw `tapIndex` transforms over the result.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  renderIndex(html: string): string {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()))
  }
}

export default WebServer
