import { describe, it, expect } from 'vitest'
import { DEFAULT_MCP_MAX_REQUEST_BODY_BYTES, envInt, formatBodyLimit, mcpMaxRequestBodyBytes } from './constants'

describe('MCP request body limit', () => {
  it('defaults to 16 MiB and takes HUTCH_MCP_MAX_BODY_BYTES when it is a positive whole number', () => {
    expect(mcpMaxRequestBodyBytes({})).toBe(DEFAULT_MCP_MAX_REQUEST_BODY_BYTES)
    expect(DEFAULT_MCP_MAX_REQUEST_BODY_BYTES).toBe(16 * 1024 * 1024)
    expect(mcpMaxRequestBodyBytes({ HUTCH_MCP_MAX_BODY_BYTES: '4194304' })).toBe(4 * 1024 * 1024)
    for (const bad of ['', 'abc', '-1', '0', '1.5']) {
      expect(mcpMaxRequestBodyBytes({ HUTCH_MCP_MAX_BODY_BYTES: bad })).toBe(DEFAULT_MCP_MAX_REQUEST_BODY_BYTES)
    }
  })

  it('formats the limit the way the tool descriptions state it', () => {
    expect(formatBodyLimit(16 * 1024 * 1024)).toBe('16 MB')
    expect(formatBodyLimit(4 * 1024 * 1024)).toBe('4 MB')
    expect(formatBodyLimit(4.5 * 1024 * 1024)).toBe('4.5 MB')
    expect(formatBodyLimit(512 * 1024)).toBe('512 KB')
  })
})

describe('envInt', () => {
  it('takes a whole number at or above min, else the fallback', () => {
    expect(envInt('X', 7, { env: {} })).toBe(7)
    expect(envInt('X', 7, { env: { X: '42' } })).toBe(42)
    expect(envInt('X', 7, { env: { X: ' 42 ' } })).toBe(42)
    for (const bad of ['', 'abc', '-1', '0', '1.5']) expect(envInt('X', 7, { env: { X: bad } })).toBe(7)
    expect(envInt('X', 7, { min: 0, env: { X: '0' } })).toBe(0)
    expect(envInt('X', 7, { min: 0, env: { X: '' } })).toBe(7)
    expect(envInt('X', 7, { min: 0, env: { X: '-1' } })).toBe(7)
  })
})
