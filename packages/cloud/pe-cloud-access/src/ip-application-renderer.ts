/** Root-only Unix channel to a separately sandboxed browser. Tenant traffic is available only through the current turn's relay. */
import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { lstat } from 'node:fs/promises'
import { posix } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { ApplicationReadLimits } from '@deepseek-ai/dsh-pe-opensandbox/types'
import type { ApplicationViewLimits } from './application-views.ts'
import type { ServiceApplicationReply } from './application-response.ts'

export const IP_APPLICATION_VIEW_PATH = '/cloud/service-application-view'
export const RENDER_ORIGIN = 'https://application-preview.invalid'
export const FRAME_WIDTH = 960
export const FRAME_HEIGHT = 640
const FRAME_SIGNATURE = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const FRAME_END = Buffer.from('0000000049454e44ae426082', 'hex')

export interface IpApplicationPreviewConfig {
  readonly socketPath: string
  readonly maxFrameBytes: number
  readonly maxReadsPerTurn: number
  readonly maxResourcePathBytes: number
  readonly closeTimeoutMs: number
  readonly maxRequestBodyBytes: number
  readonly response: ApplicationReadLimits
  readonly views: ApplicationViewLimits
}

const bytes = () => z.natural().min(1).max(1_048_576).required()
export const IpApplicationPreviewConfigSchema: z<IpApplicationPreviewConfig> = z.object({
  socketPath: z.string().required(),
  maxFrameBytes: z.natural().min(45).max(4 * 1024 * 1024).required(),
  maxReadsPerTurn: z.natural().min(1).max(128).required(),
  maxResourcePathBytes: z.natural().min(1).max(8192).required(),
  closeTimeoutMs: z.natural().min(1).max(30_000).required(),
  maxRequestBodyBytes: bytes(),
  response: z.object({
    maxBodyBytes: bytes(), maxChunkBytes: bytes(), maxChunks: z.natural().min(1).max(1024).required(),
    maxHeaderCount: z.natural().min(1).max(128).required(), maxHeaderBytes: bytes(),
  }).required(),
  views: z.object({
    maxViews: z.natural().min(1).max(32).required(), maxViewsPerAccount: z.natural().min(1).max(8).required(),
    maxRetainedBytes: z.natural().min(4096).max(64 * 1024 * 1024).required(), maxFieldBytes: bytes(),
    lifetimeMs: z.natural().min(1000).max(2_147_483_647).required(),
  }).required(),
})

/** Validate a protected, local Unix pathname and finite view/relay limits. */
export function parseIpApplicationPreviewConfig(config: IpApplicationPreviewConfig, publicOrigin: string): IpApplicationPreviewConfig {
  const origin = new URL(publicOrigin)
  const octets = origin.hostname.split('.')
  if (origin.protocol !== 'https:' || octets.length !== 4
    || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)
    || !/^\/[A-Za-z0-9_./-]+$/.test(config.socketPath) || posix.normalize(config.socketPath) !== config.socketPath
    || config.socketPath.endsWith('/') || Buffer.byteLength(config.socketPath) > 100
    || config.views.maxViewsPerAccount > config.views.maxViews || config.response.maxChunkBytes > config.response.maxBodyBytes + 1) {
    throw new TypeError('IP service previews require HTTPS on an IPv4 address, a private Unix socket and finite limits.')
  }
  return config
}

/** The optional preview cannot publish its ingress until the local private endpoint exists. */
export async function assertIpApplicationRendererSocket(socketPath: string): Promise<void> {
  const [directory, socket] = await Promise.all([lstat(posix.dirname(socketPath)), lstat(socketPath)])
  if (!directory.isDirectory() || (directory.mode & 0o022) !== 0 || !socket.isSocket() || (socket.mode & 0o007) !== 0) {
    throw new Error('Private application renderer socket is unavailable.')
  }
}

export type RenderAction = { readonly kind: 'frame' } | {
  readonly kind: 'click'
  readonly x: number
  readonly y: number
}
export type ViewAction = RenderAction | { readonly kind: 'close' }

export function readViewAction(input: unknown): ViewAction | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const row = input as Record<string, unknown>, fields = Object.keys(row).length
  if (fields === 1 && (row.kind === 'frame' || row.kind === 'close')) return { kind: row.kind }
  if (fields === 3 && row.kind === 'click' && typeof row.x === 'number' && typeof row.y === 'number'
    && Number.isInteger(row.x) && row.x >= 0 && row.x < FRAME_WIDTH
    && Number.isInteger(row.y) && row.y >= 0 && row.y < FRAME_HEIGHT) return { kind: 'click', x: row.x, y: row.y }
  return undefined
}

function readPath(path: unknown, limit: number): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || Buffer.byteLength(path) > limit
    || /[\\#\u0000-\u0020\u007f]/u.test(path)) throw new Error('Invalid private preview relay path.')
  const parsed = new URL(path, RENDER_ORIGIN)
  if (parsed.origin !== RENDER_ORIGIN || parsed.pathname + parsed.search !== path
    || /%(?:25|2f|5c)/i.test(parsed.pathname)) throw new Error('Invalid private preview relay path.')
  return path
}

/**
 * One channel per original view, with serialized frame/input operations. The peer owns an isolated browser context
 * and has no service address or credentials. It may ask for a bounded relative GET only during an admitted turn.
 */
class RendererChannel {
  readonly socket
  private readonly inbound
  private readonly terminal: Promise<void>
  private pending: Buffer = Buffer.alloc(0)

  constructor(private readonly config: IpApplicationPreviewConfig) {
    this.socket = createConnection(config.socketPath)
    this.socket.on('error', () => { /* The actual iterator and writes report transport failure. */ })
    this.terminal = new Promise<void>((resolve) => { this.socket.once('close', () => { resolve() }) })
    this.inbound = this.socket.iterator({ destroyOnReturn: false })
  }

  send(message: object): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(JSON.stringify(message) + '\n', (error) => { if (error) reject(error); else resolve() })
    })
  }

  async receive(): Promise<Record<string, unknown>> {
    const maximum = Math.ceil(this.config.maxFrameBytes / 3) * 4 + this.config.maxResourcePathBytes * 6 + 128
    const parts: Buffer[] = []
    let length = 0
    while (true) {
      if (this.pending.length === 0) {
        const chunk = await this.inbound.next()
        if (chunk.done || !Buffer.isBuffer(chunk.value)) throw new Error('Private preview renderer disconnected.')
        this.pending = chunk.value
      }
      const delimiter = this.pending.indexOf(10)
      const part = delimiter < 0 ? this.pending : this.pending.subarray(0, delimiter)
      length += part.length
      if (length > maximum) throw new Error('Private preview renderer message too large.')
      parts.push(part)
      this.pending = delimiter < 0 ? Buffer.alloc(0) : this.pending.subarray(delimiter + 1)
      if (delimiter >= 0) {
        const line = Buffer.concat(parts, length)
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
        throw new Error('Invalid private preview renderer message.')
      }
    }
  }

  async dispose(): Promise<void> {
    this.socket.destroy()
    await this.terminal
  }
}

/** One authenticated view and its private retirement ticket, with serialized frame/input operations. */
export class IpApplicationRenderer {
  private channel: RendererChannel | undefined
  private readonly ticket = randomBytes(32).toString('hex')
  private registered = false
  private opened = false
  private receiptConfirmed = false
  private running = false
  private revoked = false
  private closing: Promise<void> | undefined

  /**
   * @param config Protected worker socket and finite frame, relay and close budgets.
   * @param onDisconnect Revoke this view if its original worker channel disappears.
   */
  constructor(private readonly config: IpApplicationPreviewConfig, private readonly onDisconnect?: () => void) {}

  async render(action: RenderAction, read: (path: string) => Promise<ServiceApplicationReply>, signal: AbortSignal): Promise<Buffer> {
    if (this.running || this.revoked) throw new Error('Private preview renderer is busy or revoked.')
    signal.throwIfAborted()
    this.running = true
    if (this.channel === undefined) {
      const original = new RendererChannel(this.config)
      this.channel = original
      original.socket.once('close', () => {
        if (!this.revoked && this.channel === original) this.onDisconnect?.()
      })
    }
    const channel = this.channel
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => {
      abortTimer = setTimeout(() => { channel.socket.destroy() }, this.config.closeTimeoutMs)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (!this.opened) {
        await channel.send({ kind: 'register', ticket: this.ticket })
        await this.expectReceipt(channel, 'registered')
        this.registered = true
        signal.throwIfAborted()
        await channel.send({ kind: 'open', ticket: this.ticket })
        await this.expectReceipt(channel, 'opened')
        this.opened = true
      }
      signal.throwIfAborted()
      await channel.send(action)
      let remaining = this.config.maxReadsPerTurn
      while (true) {
        signal.throwIfAborted()
        const message = await channel.receive()
        if (message.kind === 'failed' && Object.keys(message).length === 1) throw new Error('Private preview renderer failed.')
        if (message.kind === 'frame' && typeof message.png === 'string' && Object.keys(message).length === 2) {
          const frame = Buffer.from(message.png, 'base64')
          if (frame.byteLength < 45 || frame.byteLength > this.config.maxFrameBytes
            || frame.toString('base64') !== message.png || !frame.subarray(0, 16).equals(FRAME_SIGNATURE)
            || frame.readUInt32BE(16) !== FRAME_WIDTH || frame.readUInt32BE(20) !== FRAME_HEIGHT
            || !frame.subarray(-FRAME_END.length).equals(FRAME_END)) throw new Error('Invalid private preview frame.')
          signal.throwIfAborted()
          return frame
        }
        if (message.kind !== 'read' || Object.keys(message).length !== 2 || remaining-- <= 0) {
          throw new Error('Invalid private preview renderer message.')
        }
        const reply = await read(readPath(message.path, this.config.maxResourcePathBytes))
        signal.throwIfAborted()
        await channel.send({ kind: 'resource', status: reply.status, headers: reply.headers, body: Buffer.from(reply.body).toString('base64') })
      }
    } finally {
      clearTimeout(abortTimer)
      this.running = false
      signal.removeEventListener('abort', abort)
    }
  }

  /** Revoke rendering permanently and release quota only after this ticket's real retirement receipt. */
  close(): Promise<void> {
    this.revoked = true
    this.closing ??= this.closeActual().catch((error: unknown) => {
      this.closing = undefined
      throw error
    })
    return this.closing
  }

  private async closeActual(): Promise<void> {
    const original = this.channel
    this.channel = undefined
    if (!this.registered) {
      // Only the in-memory registration was requested. No open or frame can have been sent.
      await original?.dispose()
      return
    }
    if (original !== undefined && this.opened) {
      try { await this.confirm(original, { kind: 'close' }); return }
      catch (_lostReceipt) { /* The same ticket can be checked on an independent connection. */ }
    } else await original?.dispose()
    const kind = this.receiptConfirmed || !this.opened ? 'forget' : 'recover'
    await this.confirm(new RendererChannel(this.config), { kind, ticket: this.ticket })
  }

  private async expectReceipt(channel: RendererChannel, kind: string): Promise<void> {
    const receipt = await channel.receive()
    if (receipt.kind !== kind || receipt.ticket !== this.ticket || Object.keys(receipt).length !== 2) {
      throw new Error('Private preview receipt does not confirm this ticket.')
    }
  }

  private async confirm(channel: RendererChannel, request: { kind: 'close' | 'recover' | 'forget'; ticket?: string }): Promise<void> {
    const timer = setTimeout(() => { channel.socket.destroy() }, this.config.closeTimeoutMs)
    try {
      await channel.send(request)
      if (request.kind !== 'forget') {
        await this.expectReceipt(channel, 'closed')
        this.receiptConfirmed = true
        await channel.send({ kind: 'forget', ticket: this.ticket })
      }
      await this.expectReceipt(channel, 'forgotten')
    } catch (cause) {
      throw new Error('Private preview close unconfirmed.', { cause })
    } finally {
      try { await channel.dispose() }
      finally { clearTimeout(timer) }
    }
  }
}
