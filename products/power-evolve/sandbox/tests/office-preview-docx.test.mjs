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
const run = (source, budgets = limits, signal = new AbortController().signal, deadlineAt) => prepareOfficePreviewDocx(source, budgets, signal, deadlineAt)
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
    const encode = text => {
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
    let source = pack(kind === 'xml' ? '<broken>' : kind === 'dtd' ? '<!DOCTYPE x [<!ENTITY bomb "data">]>' + xml(properties) : xml(properties),
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
