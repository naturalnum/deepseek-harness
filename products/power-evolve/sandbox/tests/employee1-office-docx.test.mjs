/** Real ZIP/XML codecs and synthetic DOCX bytes; no LibreOffice or container conversion. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { prepareOfficePreviewDocx } from '../office-preview-docx.mjs'

const kitRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/libreoffice-kit/package.json'))
const { zipSync, unzipSync } = kitRequire('fflate')
const limits = { inputBytes: 2097152, archiveEntries: 100, uncompressedBytes: 33554432, timeoutMs: 1000 }
const math = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
const xml = properties => `<?xml version="1.0" encoding="UTF-8"?>\r\n<w:document xmlns:w="urn:word" xmlns:x="${math}"><w:body>中文😀<x:oMath><x:d><x:dPr>${properties}</x:dPr><x:e><x:r><x:t>a−e</x:t></x:r></x:e></x:d></x:oMath></w:body></w:document>`
const properties = '<x:begChr x:val="|"/>\r\n<x:endChr x:val="|" note="&quot;&gt;"/><!-- retained --><x:sepChr x:val=""/><x:grow x:val="1"/>'
const ordered = '<x:begChr x:val="|"/>\r\n<x:sepChr x:val=""/><!-- retained --><x:endChr x:val="|" note="&quot;&gt;"/><x:grow x:val="1"/>'
const pack = (text, extra = {}, options) => Buffer.from(zipSync({ 'word/document.xml': Buffer.from(text), ...extra }, options))
const run = (source, budgets = limits, signal = new AbortController().signal, deadlineAt) =>
  prepareOfficePreviewDocx(source, budgets, signal, deadlineAt)
const invalid = error => error.code === 'invalid-document'

test('render copy retains exact nonproperty XML, values, nested formulas and other ZIP payloads', () => {
  const cases = '<x:begChr x:val="{"/><x:endChr x:val=""/><x:sepChr x:val=""/>'
  const expectedCases = '<x:begChr x:val="{"/><x:sepChr x:val=""/><x:endChr x:val=""/>'
  const nested = `<x:e><x:d><x:dPr>${cases}</x:dPr><x:e/></x:d></x:e>`
  const text = xml(properties).replace('<x:e><x:r>', nested + '<x:e><x:r>')
  const header = Buffer.from('\ufeff' + xml(cases).replace('UTF-8', 'UTF-16'), 'utf16le')
  const other = Buffer.from('arbitrary binary bytes\0\xff', 'latin1')
  const source = pack(text, { 'word/header1.xml': header, 'word/media/data.bin': other,
    'custom/other.xml': Buffer.from('<foreign xmlns:x="urn:foreign"><x:dPr>' + properties + '</x:dPr></foreign>') })
  const before = Buffer.from(source), copy = run(source), files = unzipSync(copy)
  assert.notDeepEqual(copy, source); assert.deepEqual(source, before)
  assert.equal(Buffer.from(files['word/document.xml']).toString(), text.replace(properties, ordered).replace(cases, expectedCases))
  assert.deepEqual(Buffer.from(files['word/header1.xml']), Buffer.from('\ufeff' + xml(expectedCases).replace('UTF-8', 'UTF-16'), 'utf16le'))
  assert.deepEqual(Buffer.from(files['word/media/data.bin']), other)
  assert.deepEqual(files['custom/other.xml'], unzipSync(source)['custom/other.xml'])
  assert.strictEqual(run(copy), copy)
})

test('ordered/default/foreign delimiters return the original ZIP and source buffer unchanged', () => {
  for (const text of [xml(ordered), xml('<x:grow x:val="1"/>'), xml(properties).replaceAll(math, 'urn:foreign')]) {
    const source = pack(text)
    assert.strictEqual(run(source), source)
  }
})

test('UTF-16 declarations without a BOM retain their encoding and source bytes', () => {
  for (const endian of ['LE', 'BE']) {
    const encode = (text) => {
      const bytes = Buffer.from(text, 'utf16le')
      return endian === 'BE' ? bytes.swap16() : bytes
    }
    const original = encode(xml(properties).replace('UTF-8', 'UTF-16' + endian))
    const source = pack(original), before = Buffer.from(source), copy = run(source)
    assert.deepEqual(source, before)
    assert.deepEqual(Buffer.from(unzipSync(copy)['word/document.xml']),
      encode(xml(ordered).replace('UTF-8', 'UTF-16' + endian)))
    assert.strictEqual(run(copy), copy)
    const malformed = pack(Buffer.concat([original, Buffer.from([0])]))
    assert.throws(() => run(malformed), invalid)
  }
})

test('archive counts, total sizes and actual inflated size stay within task budgets', () => {
  const source = pack(xml(properties), { 'word/media/data.bin': Buffer.alloc(20000) })
  assert.throws(() => run(source, { ...limits, archiveEntries: 1 }), invalid)
  assert.throws(() => run(source, { ...limits, uncompressedBytes: 1000 }), invalid)
  // Both headers lie about an otherwise valid compressed member's original size.
  const lied = pack(xml(properties)), central = lied.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  lied.writeUInt32LE(1, 22); lied.writeUInt32LE(1, central + 24)
  assert.throws(() => run(lied), invalid)
})

test('encrypted/ZIP64, duplicate/traversing members and malformed XML/DTD reject before rendering', () => {
  for (const kind of ['encrypted', 'zip64', 'duplicate', 'traversal', 'xml', 'dtd', 'crc']) {
    const source = pack(kind === 'xml' ? '<broken>' : kind === 'dtd' ? '<!DOCTYPE x [<!ENTITY bomb "data">]>' + xml(properties) : xml(properties),
      kind === 'duplicate' ? { 'word/document.xmZ': Buffer.from('<other/>') } : kind === 'traversal' ? { '../outside': Buffer.from('x') } : {})
    if (kind === 'encrypted') {
      const central = source.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      source.writeUInt16LE(source.readUInt16LE(6) | 1, 6)
      source.writeUInt16LE(source.readUInt16LE(central + 8) | 1, central + 8)
    }
    if (kind === 'zip64') source.writeUInt16LE(0xffff, source.length - 22 + 10)
    if (kind === 'duplicate') {
      const from = Buffer.from('word/document.xmZ'), to = Buffer.from('word/document.xml')
      for (let offset = source.indexOf(from); offset !== -1; offset = source.indexOf(from, offset + to.length)) to.copy(source, offset)
    }
    if (kind === 'crc') {
      const central = source.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      source.writeUInt32LE(0, 14); source.writeUInt32LE(0, central + 16)
    }
    assert.throws(() => run(source), invalid, kind)
  }
})

test('cancelled/expired tasks and a larger render ZIP fail with bounded shared error codes', () => {
  const source = pack(xml(properties))
  const controller = new AbortController(); controller.abort()
  assert.throws(() => run(source, limits, controller.signal), error => error.code === 'cancelled')
  assert.throws(() => run(source, limits, undefined, Date.now() - 1), error => error.code === 'timeout')
  assert.throws(() => run(source, { ...limits, inputBytes: source.length }), error => error.code === 'input-too-large')
})

test('stored render copies preserve directory and empty-part payloads', () => {
  const source = pack(xml(properties), { 'word/': new Uint8Array(), 'word/media/empty.bin': new Uint8Array() }, { level: 0 })
  const before = Buffer.from(source), copy = run(source), files = unzipSync(copy)
  assert.deepEqual(source, before)
  assert.match(Buffer.from(files['word/document.xml']).toString(), /<x:sepChr x:val=""\/>/u)
  assert.equal(files['word/'].byteLength, 0)
  assert.equal(files['word/media/empty.bin'].byteLength, 0)
})

test('archive budgets, missing document part and timeout reasons reject bounded input', () => {
  const source = pack(xml(ordered))
  assert.throws(() => run(source, { ...limits, inputBytes: source.length - 1 }), error => error.code === 'input-too-large')
  const missing = Buffer.from(zipSync({ 'word/header1.xml': Buffer.from('<header/>') }))
  assert.throws(() => run(missing), invalid)
  assert.throws(() => run(source, limits, AbortSignal.abort({ code: 'timeout' })), error => error.code === 'timeout')
  assert.throws(() => run(Buffer.from('malformed ZIP')), invalid)
})

test('unknown ZIP extra fields remain valid while malformed extra records reject', () => {
  const source = Buffer.from(zipSync({ 'word/document.xml': [Buffer.from(xml(ordered)), { extra: { 42: new Uint8Array([1, 2, 3]) } }] }))
  assert.strictEqual(run(source), source)
  const localExtra = 30 + source.readUInt16LE(26)
  for (const [name, mutate] of [
    ['truncated extra header', bytes => bytes.writeUInt16LE(2, 28)],
    ['oversized extra data', bytes => bytes.writeUInt16LE(100, localExtra + 2)],
    ['ZIP64 extra declaration', bytes => bytes.writeUInt16LE(1, localExtra)],
  ]) {
    const bad = Buffer.from(source); mutate(bad)
    assert.throws(() => run(bad), invalid, name)
  }
})

test('inconsistent ZIP disk, directory, local header and payload declarations reject', () => {
  const source = pack(xml(ordered), {}, { level: 0 })
  const central = source.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])), end = source.length - 22
  const mutations = [
    ['disk number', bytes => bytes.writeUInt16LE(1, end + 4)],
    ['directory disk', bytes => bytes.writeUInt16LE(1, end + 6)],
    ['central signature', bytes => bytes.writeUInt32LE(0, central)],
    ['local signature', bytes => bytes.writeUInt32LE(0, 0)],
    ['local compressed ZIP64', bytes => bytes.writeUInt32LE(0xffffffff, 18)],
    ['local original ZIP64', bytes => bytes.writeUInt32LE(0xffffffff, 22)],
    ['local member name', (bytes) => { bytes[30] ^= 1 }],
    ['local compressed count', bytes => bytes.writeUInt32LE(1, 18)],
    ['local original count', bytes => bytes.writeUInt32LE(1, 22)],
    ['local CRC', bytes => bytes.writeUInt32LE(0, 14)],
  ]
  for (const [name, mutate] of mutations) {
    const bad = Buffer.from(source); mutate(bad)
    assert.throws(() => run(bad), invalid, name)
  }
})

test('big endian XML BOM survives render-copy reordering', () => {
  const original = Buffer.from('\ufeff' + xml(properties).replace('UTF-8', 'UTF-16'), 'utf16le').swap16()
  const source = pack('<document/>', { 'word/header1.xml': original })
  const copy = run(source), files = unzipSync(copy)
  assert.deepEqual(Buffer.from(files['word/header1.xml']),
    Buffer.from('\ufeff' + xml(ordered).replace('UTF-8', 'UTF-16'), 'utf16le').swap16())
})

test('overlapping nested delimiter properties cannot manufacture a render copy', () => {
  const nested = '<x:endChr><x:dPr><x:endChr/><x:begChr/></x:dPr></x:endChr><x:begChr/>'
  assert.throws(() => run(pack(xml(nested))), invalid)
})

test('central padding, leading bytes and overlapping physical ZIP entries reject', () => {
  const source = pack(xml(ordered), {}, { level: 0 }), end = source.length - 22
  const central = source.readUInt32LE(end + 16), size = source.readUInt32LE(end + 12)
  const padding = Buffer.concat([source.subarray(0, end), Buffer.from([0]), source.subarray(end)])
  padding.writeUInt32LE(size + 1, end + 1 + 12)
  const leading = Buffer.concat([Buffer.from([0]), source])
  leading.writeUInt32LE(1, central + 1 + 42)
  leading.writeUInt32LE(central + 1, end + 1 + 16)
  const duplicate = Buffer.concat([source.subarray(0, end), source.subarray(central, end), source.subarray(end)])
  const duplicateEnd = duplicate.length - 22
  duplicate.writeUInt16LE(2, duplicateEnd + 8); duplicate.writeUInt16LE(2, duplicateEnd + 10)
  duplicate.writeUInt32LE(size * 2, duplicateEnd + 12)
  for (const [name, bytes] of [['central padding', padding], ['leading bytes', leading], ['overlap', duplicate]]) {
    assert.throws(() => run(bytes), invalid, name)
  }
})

test('an invalid DEFLATE block and a legacy member whose UTF8 name overflows reject without changing input', () => {
  const deflate = pack(xml(properties)), data = 30 + deflate.readUInt16LE(26) + deflate.readUInt16LE(28)
  // BFINAL=1/BTYPE=3 is an invalid DEFLATE block handled by the installed decoder.
  deflate[data] = (deflate[data] & 0xf8) | 7
  const longName = 'X'.repeat(40000), legacy = pack(xml(properties), { [longName]: new Uint8Array() })
  const encodedName = Buffer.from(longName)
  let matches = 0
  for (let offset = legacy.indexOf(encodedName); offset !== -1; offset = legacy.indexOf(encodedName, offset + encodedName.length)) {
    // The existing non-UTF8 ZIP name flag retains its 40,000-byte legacy member name.
    legacy.fill(0xe9, offset, offset + encodedName.length); matches++
  }
  assert.equal(matches, 2)
  for (const bytes of [deflate, legacy]) {
    const before = Buffer.from(bytes)
    assert.throws(() => run(bytes), invalid)
    assert.deepEqual(bytes, before)
  }
})
