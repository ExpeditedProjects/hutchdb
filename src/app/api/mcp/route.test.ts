import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { authenticateMock, transportHandleRequest, afterMock, buildMock } = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  transportHandleRequest: vi.fn(),
  afterMock: vi.fn(),
  buildMock: vi.fn(),
}))

// after() only works inside a Next request scope; record the callbacks instead.
vi.mock('next/server', () => ({
  after: afterMock,
}))

vi.mock('@/lib/storage/builder', () => ({
  buildPendingIndexes: buildMock,
  buildTimeoutMs: () => 600_000,
  staleBuildingMs: () => 660_000,
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
import { queueIndexBuild } from '@/lib/storage/build-queue'

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

describe('POST /api/mcp — links in tool responses', () => {
  it('hands the server the origin the request reached when HUTCH_BASE_URL is unset', async () => {
    authenticateMock.mockResolvedValue({ userId: 'u1', orgId: 'o1' })
    await POST(new Request('http://localhost:3116/api/mcp', { method: 'POST', body: '{}' }))
    const [, options] = transportHandleRequest.mock.calls[0]
    expect(options.authInfo.extra).toEqual({ userId: 'u1', orgId: 'o1', baseUrl: 'http://localhost:3116' })
  })
})

describe('POST /api/mcp — background index builds', () => {
  it('builds the collections queued during the request after the response, and only then', async () => {
    authenticateMock.mockResolvedValue({ userId: 'u1', orgId: 'o1' })
    buildMock.mockResolvedValue({ collections: [], failed: 0 })
    transportHandleRequest.mockImplementation(async () => {
      // A tool call inside the request queues work (a write that crossed a threshold).
      expect(queueIndexBuild(7)).toBe(true)
      queueIndexBuild(7)
      queueIndexBuild(9)
      return new Response('ok', { status: 200 })
    })
    const res = await POST(jsonRpcRequest({}, 'tools/call'))
    expect(res.status).toBe(200)
    expect(afterMock).toHaveBeenCalledTimes(1)
    expect(buildMock).not.toHaveBeenCalled()

    await afterMock.mock.calls[0][0]()
    expect(buildMock.mock.calls.map(([opts]) => opts.collectionId)).toEqual([7, 9])
    // Outside a request nothing is queued.
    expect(queueIndexBuild(11)).toBe(false)
  })

  it('a failing build is logged, not thrown, and the next queued collection still builds', async () => {
    authenticateMock.mockResolvedValue({ userId: 'u1', orgId: 'o1' })
    buildMock.mockRejectedValueOnce(new Error('no connection')).mockResolvedValue({ collections: [], failed: 0 })
    transportHandleRequest.mockImplementation(async () => {
      queueIndexBuild(1)
      queueIndexBuild(2)
      return new Response('ok', { status: 200 })
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await POST(jsonRpcRequest({}, 'tools/call'))
    await expect(afterMock.mock.calls[0][0]()).resolves.toBeUndefined()
    expect(buildMock).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('registers no build work for a request that fails authentication', async () => {
    authenticateMock.mockResolvedValue(null)
    await POST(jsonRpcRequest())
    expect(afterMock).not.toHaveBeenCalled()
  })
})
