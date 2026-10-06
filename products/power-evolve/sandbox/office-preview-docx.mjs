/** Bounded DOCX render-copy compatibility; original task bytes and source identity remain caller-owned. */
import { createRequire } from 'node:module'
import { crc32 } from 'node:zlib'

const mathNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
const propertyRank = new Map([['begChr', 0], ['sepChr', 1], ['endChr', 2]])
const archiveChunkBytes = 1024

function reject(code = 'invalid-document') { throw Object.assign(new Error('Office preview ' + code), { code }) }

function codecs() {
  try {
    const require = createRequire(import.meta.url)
    const kitRequire = createRequire(require.resolve('@deepseek-ai/libreoffice-kit/package.json'))
    return { ...kitRequire('fflate'), ...kitRequire('saxes') }
  } catch (_missingInstalledCodec) { reject('unavailable') }
}

// fflate owns ZIP decoding. These fixed-header checks reject unsupported encryption/ZIP64
// before that decoder sees data, and compare its local headers with the central directory.
function archiveHeaders(bytes, limits, check) {
  let end = -1
  for (let index = bytes.length - 22, minimum = Math.max(0, index - 65535); index >= minimum; index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
      end = index; break
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) reject()
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16)
  if (!count || count === 0xffff || count !== bytes.readUInt16LE(end + 8) || count > limits.archiveEntries
    || size === 0xffffffff || offset === 0xffffffff || offset + size !== end) reject()
  const records = [], ranges = []
  let position = offset, total = 0
  function extraFields(start, length) {
    const stop = start + length
    while (start < stop) {
      if (start + 4 > stop || bytes.readUInt16LE(start) === 1) reject()
      start += 4 + bytes.readUInt16LE(start + 2)
      if (start > stop) reject()
    }
  }
  for (let index = 0; index < count; index++) {
    check()
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) reject()
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10)
    const compressed = bytes.readUInt32LE(position + 20), original = bytes.readUInt32LE(position + 24)
    const nameBytes = bytes.readUInt16LE(position + 28), extraBytes = bytes.readUInt16LE(position + 30)
    const next = position + 46 + nameBytes + extraBytes + bytes.readUInt16LE(position + 32)
    const local = bytes.readUInt32LE(position + 42)
    if (bytes.readUInt16LE(position + 6) >= 45 || flags & ~0x080e || ![0, 8].includes(method)
      || compressed === 0xffffffff || original === 0xffffffff || next > end || !nameBytes
      || bytes.readUInt16LE(position + 34) !== 0 || local + 30 > offset) reject()
    total += original
    if (!Number.isSafeInteger(total) || total > limits.uncompressedBytes) reject()
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 4) >= 45
      || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method
      || bytes.readUInt32LE(local + 18) === 0xffffffff || bytes.readUInt32LE(local + 22) === 0xffffffff) reject()
    const localNameBytes = bytes.readUInt16LE(local + 26), localExtraBytes = bytes.readUInt16LE(local + 28)
    const data = local + 30 + localNameBytes + localExtraBytes
    if (localNameBytes !== nameBytes || data + compressed > offset
      || !bytes.subarray(local + 30, local + 30 + localNameBytes).equals(bytes.subarray(position + 46, position + 46 + nameBytes))) reject()
    if (!(flags & 8) && (bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== original
      || bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(position + 16))) reject()
    extraFields(position + 46 + nameBytes, extraBytes)
    extraFields(local + 30 + localNameBytes, localExtraBytes)
    records.push({ compressed, original, method, crc: bytes.readUInt32LE(position + 16) })
    ranges.push({ start: local, end: data + compressed })
    position = next
  }
  if (position !== end) reject()
  ranges.sort((left, right) => left.start - right.start)
  if (ranges[0].start !== 0) reject()
  for (let index = 1; index < ranges.length; index++) if (ranges[index].start < ranges[index - 1].end) reject()
  return records
}

function safeMember(name) {
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/')
  return !name.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(name) && !/^[A-Za-z]:/u.test(name)
    && parts.every(part => part !== '' && part !== '.' && part !== '..')
}

function xmlCopy(bytes, SaxesParser, check) {
  // XML's UTF-16 declaration prefix also identifies endian order without a BOM.
  const encoding = (bytes[0] === 255 && bytes[1] === 254)
    || (bytes[0] === 60 && bytes[1] === 0 && bytes[2] === 63 && bytes[3] === 0) ? 'utf-16le'
    : (bytes[0] === 254 && bytes[1] === 255)
      || (bytes[0] === 0 && bytes[1] === 60 && bytes[2] === 0 && bytes[3] === 63) ? 'utf-16be' : 'utf-8'
  const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes)
  const parser = new SaxesParser({ xmlns: true })
  const contexts = [], replacements = []
  let depth = 0, start = 0
  parser.on('doctype', () => reject())
  parser.on('opentagstart', () => { start = text.lastIndexOf('<', parser.position - 1) })
  parser.on('opentag', tag => {
    depth++
    if (tag.uri === mathNamespace && tag.local === 'dPr') contexts.push({ depth, children: [] })
    const context = contexts.at(-1)
    if (context && depth === context.depth + 1 && tag.uri === mathNamespace && propertyRank.has(tag.local)) {
      context.children.push({ name: tag.local, start })
    }
  })
  parser.on('closetag', () => {
    const context = contexts.at(-1)
    if (context && depth === context.depth + 1) {
      const child = context.children.at(-1)
      if (child && child.end === undefined) child.end = parser.position
    }
    if (context && depth === context.depth) {
      contexts.pop()
      const ordered = [...context.children].sort((left, right) => propertyRank.get(left.name) - propertyRank.get(right.name))
      for (let index = 0; index < ordered.length; index++) if (ordered[index] !== context.children[index]) {
        const target = context.children[index], replacement = ordered[index]
        if (!Number.isSafeInteger(target.end) || !Number.isSafeInteger(replacement.end)) reject()
        replacements.push({ start: target.start, end: target.end, text: text.slice(replacement.start, replacement.end) })
      }
    }
    depth--
  })
  for (let offset = 0; offset < text.length; offset += 16384) { check(); parser.write(text.slice(offset, offset + 16384)) }
  parser.close(); check()
  if (!replacements.length) return bytes
  replacements.sort((left, right) => left.start - right.start)
  const pieces = []
  let offset = 0
  for (const replacement of replacements) {
    if (replacement.start < offset || replacement.start < 0 || replacement.end < replacement.start) reject()
    pieces.push(text.slice(offset, replacement.start), replacement.text); offset = replacement.end
  }
  pieces.push(text.slice(offset))
  const copy = Buffer.from(pieces.join(''), encoding === 'utf-8' ? 'utf8' : 'utf16le')
  if (encoding === 'utf-16be') copy.swap16()
  if (copy.length !== bytes.length) reject()
  return copy
}

/**
 * Normalize existing Math delimiter property slots only in a bounded private DOCX render copy.
 * Maintained ZIP/XML codecs resolve through the installed kit's physical dependency closure.
 * Malformed archives/Word XML, encrypted/ZIP64/duplicate/traversing members and Word XML DTDs reject.
 * Other part payloads and the original task identity remain unchanged.
 * @param {Buffer} source - Verified original task bytes; never mutated.
 * @param {object} limits - Validated job input/archive/uncompressed/deadline budgets.
 * @param {AbortSignal} signal - Existing task cancellation/deadline.
 * @param {number} deadlineAt - Existing task deadline in wall-clock milliseconds.
 * @returns {Buffer} Original bytes when ordered, otherwise a private copy within inputBytes.
 */
export function prepareOfficePreviewDocx(source, limits, signal, deadlineAt = Date.now() + limits.timeoutMs) {
  const check = () => {
    if (signal?.aborted) reject(signal.reason?.code === 'timeout' ? 'timeout' : 'cancelled')
    if (Date.now() >= deadlineAt) reject('timeout')
  }
  check()
  const { unzipSync, Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, SaxesParser } = codecs()
  try {
    if (source.length > limits.inputBytes) reject('input-too-large')
    const headers = archiveHeaders(source, limits, check), names = new Map()
    let header = 0
    unzipSync(source, { filter(entry) {
      check()
      const expected = headers[header++]
      if (!expected || !safeMember(entry.name) || names.has(entry.name) || entry.size !== expected.compressed
        || entry.originalSize !== expected.original || entry.compression !== expected.method) reject()
      names.set(entry.name, expected)
      return false
    } })
    if (header !== headers.length || !names.has('word/document.xml')) reject()
    const files = new Map()
    let total = 0, changed = false
    const unzip = new Unzip(file => {
      check()
      const expected = names.get(file.name)
      if (!expected || files.has(file.name) || file.compression !== expected.method
        || (file.size !== undefined && file.size !== expected.compressed)
        || (file.originalSize !== undefined && file.originalSize !== expected.original)) reject()
      const record = { chunks: [], size: 0, crc: 0, complete: false, method: file.compression }
      files.set(file.name, record)
      file.ondata = (error, chunk, final) => {
        if (error) reject()
        check(); total += chunk.length; record.size += chunk.length
        if (!Number.isSafeInteger(total) || total > limits.uncompressedBytes || record.size > expected.original) reject()
        record.crc = crc32(chunk, record.crc)
        record.chunks.push(Buffer.from(chunk))
        if (final) {
          if (record.size !== expected.original || record.crc !== expected.crc) reject()
          record.bytes = Buffer.concat(record.chunks, record.size); record.chunks = undefined
          if (file.name.startsWith('word/') && file.name.endsWith('.xml')) {
            const copy = xmlCopy(record.bytes, SaxesParser, check)
            changed ||= copy !== record.bytes; record.bytes = copy
          }
          record.complete = true
        }
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    for (let offset = 0; offset < source.length; offset += archiveChunkBytes) {
      check(); unzip.push(source.subarray(offset, offset + archiveChunkBytes), offset + archiveChunkBytes >= source.length)
    }
    if (files.size !== names.size || [...files.values()].some(file => !file.complete)) reject()
    if (!changed) return source
    const chunks = []
    let outputBytes = 0, complete = false
    const zip = new Zip((error, chunk, final) => {
      if (error) reject()
      check(); outputBytes += chunk.length
      if (!Number.isSafeInteger(outputBytes) || outputBytes > limits.inputBytes) reject('input-too-large')
      chunks.push(Buffer.from(chunk)); complete ||= final
    })
    for (const [name, record] of files) {
      check()
      const file = record.method === 8 ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
      zip.add(file)
      for (let offset = 0; offset < record.bytes.length; offset += 16384) {
        check(); file.push(record.bytes.subarray(offset, offset + 16384), offset + 16384 >= record.bytes.length)
      }
      if (!record.bytes.length) file.push(new Uint8Array(), true)
    }
    zip.end(); check()
    if (!complete) reject()
    return Buffer.concat(chunks, outputBytes)
  } catch (error) {
    if (['input-too-large', 'timeout', 'cancelled'].includes(error.code)) throw error
    reject()
  }
}
