import { describe, it, expect } from 'vitest'
import { DEFAULT_MCP_MAX_REQUEST_BODY_BYTES, formatBodyLimit, mcpMaxRequestBodyBytes } from './constants'

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
