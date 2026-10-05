/** Product endpoints are refused across HTTP/WebSocket schemes and loopback aliases. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserRejectsUrl } from '../src/browser-network.ts'

test('protects fixed product services without granting access based on renderer paths', () => {
  const rejects = browserRejectsUrl({ hostOrigin: 'http://127.0.0.1:20880', platformOrigin: 'https://platform.example' }, 'http://127.0.0.1:20882')
  for (const value of ['http://127.0.0.1:20880/any', 'ws://127.0.0.1:20880/socket', 'http://localhost:20880/',
    'http://127.12.34.56:20880/', 'http://[::1]:20880/', 'http://[::ffff:127.0.0.1]:20880/',
    'http://127.1:20880/', 'http://0.0.0.0:20880/', 'http://localhost:20882/', 'http://localhost.:20880/',
    'ws://localhost.:20882/socket',
    'https://platform.example/', 'wss://platform.example/', 'http://platform.example:443/',
    'https://platform.example./', 'wss://platform.example./']) assert(rejects(new URL(value)), value)
  for (const value of ['https://example.com/', 'http://127.0.0.1:20881/', 'http://platform.example/',
    'https://platform.example.evil/', 'https://platform.example:444/', 'about:blank']) assert(!rejects(new URL(value)), value)
})
