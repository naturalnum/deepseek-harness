/** Deterministic JSON codec checks only; no SDK process, service, user data or deployed runtime. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { stdioCanonicalJsonV2, type StdioV2JsonLimits } from '../src/stdio-mcp-json.ts'

const limits: StdioV2JsonLimits = { maxDepth: 16, maxNodes: 256, maxBytes: 8192 }
const encode = (value: unknown, overrides: Partial<StdioV2JsonLimits> = {}) => stdioCanonicalJsonV2(value, { ...limits, ...overrides })

test('keys use code-unit lexical order including numeric keys, independent of input insertion order', () => {
  const raw = { '2': 2, '10': 10, z: 1, A: 2, a: 3, '\ue000': 4, '😀': 5 }
  const expected = '{"10":10,"2":2,"A":2,"a":3,"z":1,"😀":5,"\ue000":4}'
  assert.equal(encode(raw), expected)
  assert.equal(encode(Object.fromEntries(Object.entries(raw).reverse())), expected)
})

test('nested schema, metadata, Unicode and escaped NUL remain original JSON without normalization', () => {
  const raw = { name: 'raw\u0000name', inputSchema: { properties: { '2': { type: 'number' },
    '10': { type: 'string' } }, type: 'object' }, _meta: { unicode: 'é/e\u0301/中文/😀',
    'x-extension': [true, null, { text: 'value\u0000end' }] } }
  const expected = '{"_meta":{"unicode":"é/é/中文/😀","x-extension":[true,null,{"text":"value\\u0000end"}]},'
    + '"inputSchema":{"properties":{"10":{"type":"string"},"2":{"type":"number"}},"type":"object"},'
    + '"name":"raw\\u0000name"}'
  assert.equal(encode(raw), expected)
  assert.deepEqual(JSON.parse(expected), raw)
  assert.notEqual(encode('é'), encode('e\u0301'))
})

test('raw __proto__, constructor and null-prototype objects are data without prototype effects', () => {
  const raw = JSON.parse('{"constructor":"data","__proto__":{"safe":true},"2":"two","10":"ten"}')
  const expected = '{"10":"ten","2":"two","__proto__":{"safe":true},"constructor":"data"}'
  assert.equal(encode(raw), expected)
  assert.equal(Object.getPrototypeOf(raw), Object.prototype)
  assert.equal(Object.hasOwn(raw, '__proto__'), true)
  assert.equal(Object.hasOwn(Object.prototype, 'safe'), false)
  assert.equal(encode(Object.assign(Object.create(null), raw)), expected)
})

test('arrays preserve order, finite scalar JSON semantics preserve -0 as 0', () => {
  assert.equal(encode([null, false, true, -0, 1.25, '']), '[null,false,true,0,1.25,""]')
  assert.notEqual(encode([{ b: 2, a: 1 }, 2]), encode([2, { a: 1, b: 2 }]))
  assert.equal(encode([]), '[]')
  assert.equal(encode({}), '{}')
})

test('UTF-8 byte limits include punctuation, keys, astral pairs, escaped controls and lone surrogates', () => {
  for (const value of ['a', 'é', '中文', '😀', '\u0000', '\ud800', { '😀': ['中', '\u0000'] }]) {
    const encoded = encode(value)
    const size = new TextEncoder().encode(encoded).length
    assert.equal(encode(value, { maxBytes: size }), encoded)
    assert.throws(() => encode(value, { maxBytes: size - 1 }), { name: 'RangeError', message: 'stdio_v2_json_bytes_limit' })
  }
})

test('root depth zero and root plus each value occurrence determine exact limits', () => {
  const raw = { a: [1, 2] }
  assert.equal(encode(raw, { maxDepth: 2, maxNodes: 4 }), '{"a":[1,2]}')
  assert.throws(() => encode(raw, { maxDepth: 1 }), { name: 'RangeError', message: 'stdio_v2_json_depth_limit' })
  assert.throws(() => encode(raw, { maxNodes: 3 }), { name: 'RangeError', message: 'stdio_v2_json_nodes_limit' })
  assert.equal(encode(1, { maxNodes: 1 }), '1')
})

test('cycles refuse but repeated ordinary acyclic references serialize independently', () => {
  const self: Record<string, unknown> = {}; self.self = self
  const array: unknown[] = []; const child = { array }; array.push(child)
  for (const value of [self, array]) assert.throws(() => encode(value), { name: 'TypeError', message: 'stdio_v2_json_cycle' })
  const shared = { a: 1 }
  assert.equal(encode([shared, shared], { maxNodes: 5 }), '[{"a":1},{"a":1}]')
  assert.throws(() => encode([shared, shared], { maxNodes: 4 }), { message: 'stdio_v2_json_nodes_limit' })
})

test('undefined, nonfinite, non-JSON scalar and nonplain objects never become omitted or coerced values', () => {
  class Instance { value = 1 }
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('data'), () => 1,
    { a: undefined }, [undefined], new Date(), /x/u, new Map(), new Set(), new Number(1),
    new String('text'), new Instance(), Object.create({ inherited: true })]) {
    assert.throws(() => encode(value), { name: 'TypeError', message: 'stdio_v2_json_invalid' })
  }
})

test('arrays refuse holes, extra own fields and symbols instead of losing input data', () => {
  const extra = Object.assign([1], { extra: 2 })
  const gapWithExtra = Object.assign(new Array(2), { 0: 1, extra: 2 })
  const symbol = [1]; Object.defineProperty(symbol, Symbol('hidden'), { value: 1 })
  class DerivedArray extends Array {}
  for (const value of [new Array(1), [, 1], extra, gapWithExtra, symbol, new DerivedArray(1)]) {
    assert.throws(() => encode(value), { name: 'TypeError', message: 'stdio_v2_json_invalid' })
  }
})

test('own accessors, symbols and toJSON are rejected without invoking user code', () => {
  let calls = 0
  const getter = () => { calls++; return 1 }
  const values = [Object.defineProperty({}, 'field', { get: getter, enumerable: true }),
    Object.defineProperty({}, 'hidden', { get: getter }),
    Object.defineProperty([1], '0', { get: getter, enumerable: true }),
    Object.defineProperty({}, Symbol('hidden'), { value: 1 }),
    { toJSON() { calls++; return 1 } }, Object.defineProperty({}, 'hidden', { value: 1 })]
  for (const value of values) assert.throws(() => encode(value), { name: 'TypeError', message: 'stdio_v2_json_invalid' })
  assert.equal(calls, 0)
})

test('all three limits are mandatory positive safe integers; configuration getters are never invoked', () => {
  for (const name of ['maxDepth', 'maxNodes', 'maxBytes'] as const) {
    for (const invalid of [undefined, 0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
      assert.throws(() => stdioCanonicalJsonV2(null, { ...limits, [name]: invalid } as StdioV2JsonLimits),
        { name: 'TypeError', message: 'stdio_v2_json_limits_invalid' })
    }
    const absent = Object.fromEntries(Object.entries(limits).filter(([key]) => key !== name))
    assert.throws(() => stdioCanonicalJsonV2(null, absent as StdioV2JsonLimits), { message: 'stdio_v2_json_limits_invalid' })
  }
  let calls = 0
  const accessor = Object.defineProperty({ ...limits }, 'maxDepth', { get() { calls++; return 1 } })
  assert.throws(() => stdioCanonicalJsonV2(null, accessor), { message: 'stdio_v2_json_limits_invalid' })
  assert.equal(calls, 0)
  assert.equal(stdioCanonicalJsonV2(null, { maxDepth: Number.MAX_SAFE_INTEGER,
    maxNodes: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }), 'null')
})

test('valid deep values use supplied budgets without a recursive host stack or hidden depth default', () => {
  let value: unknown = 0
  const depth = 3000
  for (let index = 0; index < depth; index++) value = { x: value }
  const encoded = encode(value, { maxDepth: depth, maxNodes: depth + 1, maxBytes: 20000 })
  assert.equal(encoded, '{"x":'.repeat(depth) + '0' + '}'.repeat(depth))
  assert.throws(() => encode(value, { maxDepth: depth - 1, maxNodes: depth + 1, maxBytes: 20000 }),
    { message: 'stdio_v2_json_depth_limit' })
})
