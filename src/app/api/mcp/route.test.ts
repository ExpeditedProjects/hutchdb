import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { authenticateMock, transportHandleRequest } = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  transportHandleRequest: vi.fn(),
}))

vi.mock('@/lib/auth/seam', () => ({
  authenticate: authenticateMock,
}))

vi.mock('@/lib/mcp/server', () => ({
  createMcpServer: vi.fn(() => ({
    server: { connect: vi.fn().mockResolvedValue(undefined) },
  })),
}))

vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: () => ({
    fetch: transportHandleRequest,
  }),
}))

import { POST } from './route'

function jsonRpcRequest(headers: Record<string, string> = {}, method = 'tools/list'): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  transportHandleRequest.mockResolvedValue(new Response('ok', { status: 200 }))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/mcp — HUTCH_API_KEY set', () => {
  beforeEach(() => {
    vi.stubEnv('HUTCH_API_KEY', 'the-key')
  })

  it('returns 401 with NO WWW-Authenticate header when the bearer is missing', async () => {
    authenticateMock.mockResolvedValue(null)
    const res = await POST(jsonRpcRequest())
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it('returns 401 with NO WWW-Authenticate header when the bearer is wrong', async () => {
    authenticateMock.mockResolvedValue(null)
    const res = await POST(jsonRpcRequest({ authorization: 'Bearer nope' }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it('does not return 401 when authenticate resolves a context', async () => {
    authenticateMock.mockResolvedValue({ userId: 'u1', orgId: 'o1' })
    const res = await POST(jsonRpcRequest({ authorization: 'Bearer the-key' }))
    expect(res.status).not.toBe(401)
  })
})

describe('POST /api/mcp — HUTCH_API_KEY unset', () => {
  it('does not return 401 for a request with no Authorization header', async () => {
    authenticateMock.mockResolvedValue({ userId: 'u1', orgId: 'o1' })
    const res = await POST(jsonRpcRequest())
    expect(res.status).not.toBe(401)
  })
})
