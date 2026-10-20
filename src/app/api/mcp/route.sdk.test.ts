import { describe, it, expect, vi, beforeEach } from 'vitest'

// The real SDK handler (createMcpHandler) serves a real JSON-RPC tools/call;
// only the server factory is replaced, by one whose single tool queues a
// build the way hutch tools do (queueDueIndexBuild -> queueIndexBuild).
// This proves tool callbacks run inside withIndexBuildQueue's async
// context, so the route's after() drain sees what they queued.

const { authenticateMock, afterMock, buildMock, queuedInTool } = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  afterMock: vi.fn(),
  buildMock: vi.fn(),
  queuedInTool: [] as boolean[],
}))

vi.mock('next/server', () => ({ after: afterMock }))

vi.mock('@/lib/storage/builder', () => ({
  buildPendingIndexes: buildMock,
  buildTimeoutMs: () => 600_000,
  staleBuildingMs: () => 660_000,
}))

vi.mock('@/lib/auth/seam', () => ({ authenticate: authenticateMock }))

vi.mock('@/lib/mcp/server', async () => {
  const { McpServer } = await import('@modelcontextprotocol/server')
  const { queueIndexBuild } = await import('@/lib/storage/build-queue')
  return {
    createMcpServer: () => {
      const server = new McpServer({ name: 'test', version: '1.0.0' })
      server.registerTool('queue_build', { description: 'Queues a build for collection 5.' }, async () => {
        queuedInTool.push(queueIndexBuild(5))
        return { content: [{ type: 'text', text: 'queued' }] }
      })
      return server
    },
  }
})

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  queuedInTool.length = 0
  authenticateMock.mockResolvedValue({ userId: 'u1', orgId: 'o1' })
  buildMock.mockResolvedValue({ collections: [], failed: 0 })
})

function rpc(body: unknown): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/mcp — real SDK handler', () => {
  it('a tool call that queues a build inside the request gets it built by the after() drain', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'queue_build', arguments: {} } }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('queued')
    expect(queuedInTool).toEqual([true])
    expect(afterMock).toHaveBeenCalledTimes(1)
    expect(buildMock).not.toHaveBeenCalled()
    await afterMock.mock.calls[0][0]()
    expect(buildMock).toHaveBeenCalledTimes(1)
    expect(buildMock.mock.calls[0][0]).toMatchObject({ collectionId: 5 })
  })
})
