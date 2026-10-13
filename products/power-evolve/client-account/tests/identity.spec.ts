import { expect, it } from 'vitest'
import { initials } from '../src/client/identity.ts'
import { apply, trustedAccountAssets } from '../src/index.ts'

const passiveApply: () => unknown = apply

it.each([['', '?'], ['  ', '?'], ['alice', 'AL'], ['alice example third', 'AE'],
  ['😀😎a', '😀😎'], ['😀 name', '😀N'], ['张 三', '张三']])('derives Unicode avatar initials from %j', (input, expected) => {
  expect(initials(input)).toBe(expected)
})
it('exposes a passive trusted asset descriptor without installing a server plugin', () => {
  expect(passiveApply()).toBeUndefined()
  expect(trustedAccountAssets.pathname).toMatch(/\/trusted\/$/u)
})
