import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/config', () => ({ config: { baseUrl: undefined } }))

import { publicBaseUrl } from './base-url'

// A plain object: fetch's Request drops the forbidden Host header, which a server request carries.
const req = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } }) as unknown as Request

describe('publicBaseUrl', () => {
  it('uses the configured public URL, without a trailing slash', () => {
    expect(publicBaseUrl(req('http://localhost:3116/api/mcp'), 'https://hutch.example.com/')).toBe('https://hutch.example.com')
  })

  it('falls back to the host the request reached', () => {
    expect(publicBaseUrl(req('http://localhost:3116/api/mcp'))).toBe('http://localhost:3116')
    expect(publicBaseUrl(req('http://127.0.0.1:3116/api/mcp', { host: 'core.lan:8080' }))).toBe('http://core.lan:8080')
  })

  it('prefers the forwarded host and scheme from a reverse proxy', () => {
    expect(publicBaseUrl(req('http://10.0.0.5:3000/api/mcp', { 'x-forwarded-host': 'data.example.org, proxy.internal', 'x-forwarded-proto': 'https' }))).toBe('https://data.example.org')
  })

  it('ignores a forwarded host that is not a bare host[:port], or an odd scheme', () => {
    expect(publicBaseUrl(req('http://localhost:3116/api/mcp', { 'x-forwarded-host': 'evil.com/path' }))).toBe('http://localhost:3116')
    expect(publicBaseUrl(req('http://localhost:3116/api/mcp', { 'x-forwarded-proto': 'javascript' }))).toBe('http://localhost:3116')
  })

  it('treats an empty configured value as unset', () => {
    expect(publicBaseUrl(req('http://localhost:3118/api/mcp'), '  ')).toBe('http://localhost:3118')
  })
})
