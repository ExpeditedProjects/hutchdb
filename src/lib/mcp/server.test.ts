import { describe, it, expect, vi, beforeEach } from 'vitest'

const { registeredTools, registeredConfigs } = vi.hoisted(() => ({
  registeredTools: new Map<string, (params: unknown) => Promise<unknown>>(),
  registeredConfigs: new Map<string, Record<string, unknown>>(),
}))

vi.mock('@modelcontextprotocol/server', () => {
  class McpServer {
    registerTool(name: string, config: Record<string, unknown>, handler: (params: unknown) => Promise<unknown>) {
      registeredTools.set(name, handler)
      registeredConfigs.set(name, config)
    }
  }
  return { McpServer }
})

vi.mock('@/lib/services/collections', () => ({
  listCollections: vi.fn(),
  getCollection: vi.fn(),
  describeCollection: vi.fn(),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
  inferCollectionSchema: vi.fn(),
  updateFieldDefinition: vi.fn(),
  getCollectionStats: vi.fn(),
}))

vi.mock('@/lib/services/records', () => ({
  createRecords: vi.fn(),
  queryRecords: vi.fn(),
  truncateRecords: vi.fn(),
  updateRecord: vi.fn(),
  transformRecords: vi.fn(),
  updateRecordStatus: vi.fn(),
  deleteRecord: vi.fn(),
  searchGlobal: vi.fn(),
  exportRecords: vi.fn(),
  importRecords: vi.fn(),
}))

vi.mock('@/lib/services/views', () => ({
  createView: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })) })),
  },
}))

import { createMcpServer } from './server'
import { FILTER_OPERATORS } from '@/lib/db/queries'
import * as collectionService from '@/lib/services/collections'
import * as recordService from '@/lib/services/records'
import { createView } from '@/lib/services/views'

beforeEach(() => {
  vi.clearAllMocks()
  registeredTools.clear()
  registeredConfigs.clear()
})

describe('createMcpServer tool registration', () => {
  it('registers the single-user Core data-tool surface', () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    const expected = [
      'hutch_list_collections', 'hutch_get_collection', 'hutch_describe_collection',
      'hutch_store_records', 'hutch_query_records', 'hutch_search', 'hutch_update_collection',
      'hutch_delete_collection', 'hutch_delete_record', 'hutch_update_record', 'hutch_transform_records',
      'hutch_set_record_status', 'hutch_infer_schema', 'hutch_update_schema', 'hutch_create_view',
      'hutch_collection_stats', 'hutch_export_records', 'hutch_import_records',
    ]
    for (const name of expected) {
      expect(registeredTools.has(name), `expected tool ${name} to be registered`).toBe(true)
    }
  })

  it('does not register sharing, organization, or transfer tools', () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    const removed = [
      'hutch_list_collection_members', 'hutch_list_collection_invitations',
      'hutch_invite_collection_member', 'hutch_revoke_collection_invitation',
      'hutch_remove_collection_member', 'hutch_list_my_pending_invitations',
      'hutch_accept_invitation', 'hutch_decline_invitation',
      'hutch_list_organizations', 'hutch_create_organization',
      'hutch_list_organization_members', 'hutch_list_organization_invitations',
      'hutch_invite_organization_member', 'hutch_revoke_organization_invitation',
      'hutch_remove_organization_member', 'hutch_list_my_pending_organization_invitations',
      'hutch_accept_organization_invitation', 'hutch_decline_organization_invitation',
      'hutch_transfer_collection',
    ]
    for (const name of removed) {
      expect(registeredTools.has(name), `${name} should NOT be registered in Core`).toBe(false)
    }
  })

  it('gives every registered tool a non-empty human-readable title', () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    expect(registeredConfigs.size).toBeGreaterThan(0)
    for (const [name, config] of registeredConfigs) {
      const title = config.title
      expect(typeof title, `expected tool ${name} to have a string title`).toBe('string')
      expect((title as string).length, `expected tool ${name} to have a non-empty title`).toBeGreaterThan(0)
    }
  })
})

describe('tool surface snapshot', () => {
  // Deliberate-drift gate for the connectors directory: any change to a tool
  // name, title, safety annotations, or input keys must update this literal.
  it('matches the pinned 18-tool connector surface exactly', () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')

    const surface = [...registeredConfigs.entries()]
      .map(([name, config]) => {
        const annotations = (config.annotations ?? {}) as {
          readOnlyHint?: boolean
          destructiveHint?: boolean
          idempotentHint?: boolean
        }
        return {
          name,
          title: config.title as string,
          readOnlyHint: annotations.readOnlyHint,
          destructiveHint: annotations.destructiveHint,
          idempotentHint: annotations.idempotentHint,
          // v2 registers inputSchema as a z.object(...) — field names live on .shape.
          inputKeys: Object.keys(
            ((config.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {})
          ).sort(),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))

    expect(surface).toEqual([
      { name: 'hutch_collection_stats', title: 'Collection Stats', readOnlyHint: true, idempotentHint: true, inputKeys: ['slug'] },
      { name: 'hutch_create_view', title: 'Create View', destructiveHint: false, idempotentHint: false, inputKeys: ['columns', 'config', 'filter', 'group_by', 'name', 'slug', 'sort', 'type'] },
      { name: 'hutch_delete_collection', title: 'Delete Collection', destructiveHint: true, idempotentHint: true, inputKeys: ['slug'] },
      { name: 'hutch_delete_record', title: 'Delete Record', destructiveHint: true, idempotentHint: true, inputKeys: ['record_id', 'slug'] },
      { name: 'hutch_describe_collection', title: 'Describe Collection', readOnlyHint: true, idempotentHint: true, inputKeys: ['slug'] },
      { name: 'hutch_export_records', title: 'Export Records', readOnlyHint: true, idempotentHint: true, inputKeys: ['collection', 'fields', 'filter', 'format', 'limit', 'search', 'sort'] },
      { name: 'hutch_get_collection', title: 'Get Collection', readOnlyHint: true, idempotentHint: true, inputKeys: ['slug'] },
      { name: 'hutch_import_records', title: 'Import Records', destructiveHint: false, idempotentHint: false, inputKeys: ['collection', 'content', 'format', 'on_conflict'] },
      { name: 'hutch_infer_schema', title: 'Infer Schema', destructiveHint: true, idempotentHint: true, inputKeys: ['slug'] },
      { name: 'hutch_list_collections', title: 'List Collections', readOnlyHint: true, idempotentHint: true, inputKeys: [] },
      { name: 'hutch_query_records', title: 'Query Records', readOnlyHint: true, idempotentHint: true, inputKeys: ['aggregate', 'created_after', 'created_before', 'fields', 'filter', 'group_by', 'limit', 'offset', 'search', 'slug', 'sort', 'time_bucket'] },
      { name: 'hutch_search', title: 'Search Records', readOnlyHint: true, idempotentHint: true, inputKeys: ['limit', 'search'] },
      { name: 'hutch_set_record_status', title: 'Set Record Status', destructiveHint: true, idempotentHint: true, inputKeys: ['record_id', 'slug', 'status'] },
      { name: 'hutch_store_records', title: 'Store Records', destructiveHint: false, idempotentHint: true, inputKeys: ['collection', 'data', 'on_conflict', 'records'] },
      { name: 'hutch_transform_records', title: 'Transform Records', destructiveHint: true, idempotentHint: false, inputKeys: ['remove_fields', 'rename_fields', 'set_field', 'slug'] },
      { name: 'hutch_update_collection', title: 'Update Collection', destructiveHint: true, idempotentHint: true, inputKeys: ['description', 'name', 'published', 'slug', 'unique_key'] },
      { name: 'hutch_update_record', title: 'Update Record', destructiveHint: true, idempotentHint: true, inputKeys: ['data', 'record_id', 'slug'] },
      { name: 'hutch_update_schema', title: 'Update Schema', destructiveHint: true, idempotentHint: true, inputKeys: ['field', 'hidden', 'options', 'position', 'slug', 'type'] },
    ])
  })
})

describe('error hygiene chokepoint', () => {
  it('masks DrizzleQueryError-shaped failures with a generic database message and logs the real error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    createMcpServer('user-1', 'org-test', 'https://example.test')

    // Mirror drizzle-orm 0.45's DrizzleQueryError: message leads with
    // "Failed query: <sql>\nparams: <params>" (the class never assigns
    // this.name, so the message prefix is the live signal).
    const driverError = new Error(
      'Failed query: UPDATE records SET data = $1 WHERE id = $2\nparams: {"secret":"hunter2"},42'
    )
    vi.mocked(recordService.queryRecords).mockRejectedValue(driverError)

    const result = await registeredTools.get('hutch_query_records')!({ slug: 'users' }) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toBe('hutch_query_records failed while accessing the database. Try again or adjust the inputs.')
    // No driver internals leak into the client-visible text.
    expect(text).not.toMatch(/UPDATE/)
    expect(text).not.toMatch(/params/)
    expect(text).not.toMatch(/query:/)
    expect(text).not.toMatch(/hunter2/)
    // The real error is still logged server-side for operators.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('hutch_query_records'), driverError)
    consoleError.mockRestore()
  })

  it('masks errors carrying the DrizzleQueryError name even without the message prefix', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    createMcpServer('user-1', 'org-test', 'https://example.test')

    const driverError = new Error('connection terminated unexpectedly')
    driverError.name = 'DrizzleQueryError'
    vi.mocked(collectionService.listCollections).mockRejectedValue(driverError)

    const result = await registeredTools.get('hutch_list_collections')!({}) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('hutch_list_collections failed while accessing the database. Try again or adjust the inputs.')
    consoleError.mockRestore()
  })

  it('rethrows non-database errors unchanged so validation messages reach the client via the SDK', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')

    const validationError = new Error(
      "Unsupported filter operator '$regex'. Supported: $gt, $gte, $lt, $lte, $ne, $in, $nin, $exists, $contains"
    )
    vi.mocked(recordService.queryRecords).mockRejectedValue(validationError)

    // The SDK stringifies rethrown errors into the tool output verbatim, so
    // asserting the wrapped handler rejects with the exact error matches
    // what the client ends up seeing.
    await expect(registeredTools.get('hutch_query_records')!({ slug: 'users', filter: { name: { $regex: 'x' } } }))
      .rejects.toThrow("Unsupported filter operator '$regex'. Supported: $gt, $gte, $lt, $lte, $ne, $in, $nin, $exists, $contains")
  })
})

describe('response size budgets', () => {
  it('keeps hutch_list_collections under 48KB for 50 collections with long descriptions', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')

    // 500-char descriptions on every collection — the worst realistic case
    // for a busy account. Measured response: ~41,100 bytes (descriptions
    // alone are 25,000, so a 32KB budget is not attainable at this fixture
    // size); budget pinned at the next round bound, 48KB.
    const longDescription = (i: number) =>
      `Collection ${i}: `.padEnd(
        500,
        'Curated research links and notes gathered by the agent during long-running investigations, including source URLs, extraction timestamps, relevance scores, and reviewer annotations. '
      )
    vi.mocked(collectionService.listCollections).mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        name: `Research Collection ${i + 1}`,
        slug: `research-collection-${i + 1}`,
        description: longDescription(i + 1),
        uniqueKey: ['url', 'captured_at'],
        published: i % 2 === 0,
        recordCount: 12000 + i,
        lastRecordAt: '2026-08-01T12:34:56.000Z',
        updatedAt: '2026-08-02T01:23:45.000Z',
      })) as never
    )

    const result = await registeredTools.get('hutch_list_collections')!({}) as { content: { text: string }[] }
    const bytes = Buffer.byteLength(result.content[0].text, 'utf8')
    expect(bytes).toBeLessThan(48 * 1024)
    // Sanity: the fixture is actually big — a shrunken fixture would make
    // the budget assertion meaningless.
    expect(bytes).toBeGreaterThan(30 * 1024)
  })

  it('keeps a default hutch_query_records page under 128KB for 50 records of ~1KB data each', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')

    // Each record's data serializes to ~1.1KB compact JSON; the pretty-printed
    // 50-record default page measures ~70,100 bytes. Budget pinned at 128KB.
    const recordData = (i: number) => ({
      title: `Record ${i} — long-form captured artifact title with descriptive suffix`,
      url: `https://example.com/articles/${i}/full-text-analysis`,
      status: 'active',
      score: 0.87,
      tags: ['research', 'agent', 'longform'],
      notes: 'N'.padEnd(700, 'Detailed extraction notes covering methodology, source reliability, cross-references and follow-up actions. '),
      summary: 'S'.padEnd(180, 'Concise summary text for the record body. '),
    })
    vi.mocked(recordService.queryRecords).mockResolvedValue({
      records: Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        status: 'active',
        created_at: '2026-08-01T12:34:56.000Z',
        updated_at: '2026-08-02T01:23:45.000Z',
        data: recordData(i + 1),
      })),
      total: 50,
      limit: 50,
      offset: 0,
    } as never)

    const result = await registeredTools.get('hutch_query_records')!({ slug: 'research' }) as { content: { text: string }[] }
    const bytes = Buffer.byteLength(result.content[0].text, 'utf8')
    expect(bytes).toBeLessThan(128 * 1024)
    // Sanity: the fixture really carries ~50KB+ of payload.
    expect(bytes).toBeGreaterThan(50 * 1024)
  })
})

describe('tool input schemas and descriptions', () => {
  it('caps import content at 10MB in the zod schema (mirrors the service-level cap)', () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    const schema = (registeredConfigs.get('hutch_import_records')!.inputSchema as {
      shape: { content: { safeParse: (v: unknown) => { success: boolean } } }
    }).shape.content
    expect(schema.safeParse('a'.repeat(100)).success).toBe(true)
    expect(schema.safeParse('a'.repeat(10 * 1024 * 1024 + 1)).success).toBe(false)
  })

  it('enumerates every FILTER_OPERATORS entry in the filter description', () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    const filter = (registeredConfigs.get('hutch_query_records')!.inputSchema as {
      shape: { filter: { description?: string } }
    }).shape.filter
    for (const op of FILTER_OPERATORS) {
      expect(filter.description, `expected filter description to mention ${op}`).toContain(op)
    }
  })
})

describe('store_records tool', () => {
  it('forwards params to recordService.createRecords and returns the result as JSON text', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(recordService.createRecords).mockResolvedValue({
      collection: { name: 'Users', slug: 'users' },
      action: 'created',
      record: { id: 1 },
    } as never)

    const result = await registeredTools.get('hutch_store_records')!({
      collection: 'Users',
      data: { name: 'Alice' },
    })

    expect(recordService.createRecords).toHaveBeenCalledWith('user-1', 'org-test', expect.objectContaining({
      collection: 'Users',
      data: { name: 'Alice' },
    }))
    const text = (result as { content: { text: string }[] }).content[0].text
    expect(JSON.parse(text)).toEqual(expect.objectContaining({ action: 'created' }))
  })

  it('returns isError when the service reports a validation error', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(recordService.createRecords).mockResolvedValue({ error: 'oops', status: 400 } as never)

    const result = await registeredTools.get('hutch_store_records')!({ collection: 'Users', data: {} }) as {
      isError?: boolean
      content: { text: string }[]
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('oops')
  })

  it('prepends the service summary as a leading line above the JSON body (issue #447)', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(recordService.createRecords).mockResolvedValue({
      collection: { name: 'Users', slug: 'users' },
      action: 'created',
      record: { id: 1 },
      summary: 'Saved 1 record to Users',
    } as never)

    const result = await registeredTools.get('hutch_store_records')!({
      collection: 'Users',
      data: { name: 'Alice' },
    }) as { content: { text: string }[] }

    const text = result.content[0].text
    expect(text).toMatch(/^Saved 1 record to Users\n\n\{/)
    // The JSON body still parses and still contains the summary field.
    const jsonStart = text.indexOf('{')
    expect(JSON.parse(text.slice(jsonStart))).toEqual(expect.objectContaining({
      summary: 'Saved 1 record to Users',
      action: 'created',
    }))
  })
})

describe('query_records tool', () => {
  it('forwards operator filters and the fields projection param to the service', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(recordService.queryRecords).mockResolvedValue({ records: [], total: 0 } as never)

    await registeredTools.get('hutch_query_records')!({
      slug: 'products',
      filter: { price: { $gte: 10 }, status: 'active' },
      fields: ['title', 'price'],
    })

    expect(recordService.queryRecords).toHaveBeenCalledWith('products', 'user-1', expect.objectContaining({
      filter: { price: { $gte: 10 }, status: 'active' },
      fields: ['title', 'price'],
    }))
  })
})

describe('collection_stats tool', () => {
  it('returns the stats payload as JSON text', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(collectionService.getCollectionStats).mockResolvedValue({
      name: 'Users',
      slug: 'users',
      record_count: 4,
      by_status: { active: 4 },
      first_created_at: '2026-01-01',
      last_created_at: '2026-02-01',
      first_updated_at: '2026-01-01',
      last_updated_at: '2026-02-02',
      approx_storage_bytes: 2048,
      fields: [{ name: 'email', count: 4, percent: 100 }],
    })

    const result = await registeredTools.get('hutch_collection_stats')!({ slug: 'users' }) as { content: { text: string }[] }

    expect(collectionService.getCollectionStats).toHaveBeenCalledWith('users', 'user-1')
    expect(JSON.parse(result.content[0].text)).toEqual(expect.objectContaining({
      record_count: 4,
      by_status: { active: 4 },
      approx_storage_bytes: 2048,
      fields: [{ name: 'email', count: 4, percent: 100 }],
    }))
  })

  it('returns isError when the collection is not found', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(collectionService.getCollectionStats).mockResolvedValue(null)

    const result = await registeredTools.get('hutch_collection_stats')!({ slug: 'missing' }) as { isError?: boolean }
    expect(result.isError).toBe(true)
  })
})

describe('export_records tool', () => {
  it('forwards format/filter/search/sort/fields/limit and returns metadata + content', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(recordService.exportRecords).mockResolvedValue({
      collection: { name: 'Users', slug: 'users' },
      format: 'csv',
      count: 1,
      total: 1,
      truncated: false,
      content: 'id,created_at,updated_at,name\r\n1,2026-01-01,2026-01-02,Alice\r\n',
    } as never)

    const result = await registeredTools.get('hutch_export_records')!({
      collection: 'users',
      format: 'csv',
      filter: { active: true },
      fields: ['name'],
      limit: 5,
    }) as { content: { text: string }[] }

    expect(recordService.exportRecords).toHaveBeenCalledWith('users', 'user-1', expect.objectContaining({
      format: 'csv',
      filter: { active: true },
      fields: ['name'],
      limit: 5,
    }))
    expect(JSON.parse(result.content[0].text)).toEqual(expect.objectContaining({
      format: 'csv',
      count: 1,
      truncated: false,
      content: expect.stringContaining('id,created_at,updated_at,name'),
    }))
  })

  it('returns isError when the collection is not found', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(recordService.exportRecords).mockResolvedValue(null)

    const result = await registeredTools.get('hutch_export_records')!({ collection: 'missing' }) as { isError?: boolean }
    expect(result.isError).toBe(true)
  })
})

describe('import_records tool', () => {
  it('forwards content and on_conflict, prepends the summary, and includes the collection url', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(recordService.importRecords).mockResolvedValue({
      collection: { name: 'Users', slug: 'users' },
      count: 2,
      created: 2,
      updated: 0,
      skipped: 0,
      summary: 'Saved 2 records to Users',
    } as never)

    const result = await registeredTools.get('hutch_import_records')!({
      collection: 'users',
      content: 'name\r\nAlice\r\nBob\r\n',
      on_conflict: 'skip',
    }) as { content: { text: string }[] }

    expect(recordService.importRecords).toHaveBeenCalledWith('user-1', 'org-test', expect.objectContaining({
      collection: 'users',
      content: 'name\r\nAlice\r\nBob\r\n',
      on_conflict: 'skip',
    }))
    const text = result.content[0].text
    expect(text).toMatch(/^Saved 2 records to Users\n\n\{/)
    const parsed = JSON.parse(text.slice(text.indexOf('{')))
    expect(parsed).toEqual(expect.objectContaining({
      count: 2,
      created: 2,
      url: 'https://example.test/c/users',
    }))
  })

  it('returns isError when the service reports a parse error', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(recordService.importRecords).mockResolvedValue({ error: 'CSV content is empty — a header row is required', status: 400 } as never)

    const result = await registeredTools.get('hutch_import_records')!({ collection: 'users', content: '' }) as {
      isError?: boolean
      content: { text: string }[]
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/header row/)
  })
})

describe('create_view tool', () => {
  it('does not require a name parameter and forwards type to the service', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(createView).mockResolvedValue({ view: { id: 1, name: 'Table' } } as never)

    await registeredTools.get('hutch_create_view')!({ slug: 'users', type: 'table' })
    expect(createView).toHaveBeenCalledWith('users', 'user-1', expect.objectContaining({ type: 'table' }))
    const passed = vi.mocked(createView).mock.calls[0][2]
    expect(passed).not.toHaveProperty('name')
  })

  it('returns isError when the collection is not found', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(createView).mockResolvedValue(null)

    const result = await registeredTools.get('hutch_create_view')!({ slug: 'missing' }) as { isError?: boolean }
    expect(result.isError).toBe(true)
  })

  it('infers groupBy from the first select field of the collection schema for kanban views', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(collectionService.getCollection).mockResolvedValue({
      id: 1,
      name: 'Tasks',
      slug: 'tasks',
      schema: {
        fields: [
          { name: 'title', type: 'text', inferred: true, position: 0, hidden: false },
          { name: 'status', type: 'select', inferred: true, position: 1, hidden: false, options: ['todo', 'done'] },
          { name: 'priority', type: 'select', inferred: true, position: 2, hidden: false, options: ['low', 'high'] },
        ],
        version: 1,
        lastInferredAt: new Date().toISOString(),
      },
    } as never)
    vi.mocked(createView).mockResolvedValue({ view: { id: 1, name: 'Kanban' } } as never)

    await registeredTools.get('hutch_create_view')!({ slug: 'tasks', type: 'kanban' })

    expect(createView).toHaveBeenCalledWith('tasks', 'user-1', expect.objectContaining({
      type: 'kanban',
      groupBy: 'status',
    }))
  })

  it('returns isError mentioning group_by when kanban requested but collection has no select fields', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(collectionService.getCollection).mockResolvedValue({
      id: 1,
      name: 'Tasks',
      slug: 'tasks',
      schema: {
        fields: [
          { name: 'title', type: 'text', inferred: true, position: 0, hidden: false },
          { name: 'count', type: 'number', inferred: true, position: 1, hidden: false },
        ],
        version: 1,
        lastInferredAt: new Date().toISOString(),
      },
    } as never)

    const result = await registeredTools.get('hutch_create_view')!({ slug: 'tasks', type: 'kanban' }) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/group_by/)
    expect(createView).not.toHaveBeenCalled()
  })

  it('forwards an explicit group_by for kanban without consulting the schema', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(createView).mockResolvedValue({ view: { id: 1, name: 'Kanban' } } as never)

    await registeredTools.get('hutch_create_view')!({ slug: 'tasks', type: 'kanban', group_by: 'priority' })

    expect(createView).toHaveBeenCalledWith('tasks', 'user-1', expect.objectContaining({
      type: 'kanban',
      groupBy: 'priority',
    }))
    expect(collectionService.getCollection).not.toHaveBeenCalled()
  })

  it('does not forward groupBy to createView for non-kanban view types', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(createView).mockResolvedValue({ view: { id: 1, name: 'Table' } } as never)

    await registeredTools.get('hutch_create_view')!({ slug: 'tasks', type: 'table', group_by: 'status' })

    const passed = vi.mocked(createView).mock.calls[0][2] as { groupBy?: string }
    expect(passed.groupBy).toBeUndefined()
  })

  it('forwards an explicit name to createView', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(createView).mockResolvedValue({ view: { id: 1, name: 'My Board' } } as never)

    await registeredTools.get('hutch_create_view')!({
      slug: 'tasks',
      type: 'kanban',
      name: 'My Board',
      group_by: 'status',
    })

    expect(createView).toHaveBeenCalledWith('tasks', 'user-1', expect.objectContaining({
      name: 'My Board',
    }))
  })
})

describe('list_collections tool', () => {
  it('returns the collections array as JSON text', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(collectionService.listCollections).mockResolvedValue([
      { id: 1, name: 'Users', slug: 'users' },
    ] as never)

    const result = await registeredTools.get('hutch_list_collections')!({}) as { content: { text: string }[] }
    expect(JSON.parse(result.content[0].text)).toEqual([
      expect.objectContaining({ name: 'Users', slug: 'users' }),
    ])
  })

  it('omits each collection schema so large accounts get a summary, not a dump', async () => {
    createMcpServer('user-1', 'org-test', 'https://example.test')
    vi.mocked(collectionService.listCollections).mockResolvedValue([
      {
        id: 1, name: 'Users', slug: 'users', description: null, uniqueKey: [],
        published: false, recordCount: 3, lastRecordAt: null, updatedAt: new Date('2026-01-01'),
        schema: { fields: [{ name: 'huge', type: 'text' }], version: 9 },
        role: 'owner', createdAt: new Date('2026-01-01'),
      },
    ] as never)

    const result = await registeredTools.get('hutch_list_collections')!({}) as { content: { text: string }[] }
    const [row] = JSON.parse(result.content[0].text)
    expect(row).toEqual(expect.objectContaining({ slug: 'users', recordCount: 3 }))
    expect(row).not.toHaveProperty('schema')
    expect(row).not.toHaveProperty('role')
  })
})

describe('collection url in mutation responses', () => {
  const BASE_URL = 'https://example.test'

  // Extract the JSON portion of an MCP tool response text. Some handlers
  // (e.g. store_records) prepend a "${summary}\n\n" line above the JSON body.
  function parseResponseJson(text: string): Record<string, unknown> {
    const jsonStart = text.indexOf('{')
    if (jsonStart === -1) throw new Error(`no JSON object in response text: ${text}`)
    return JSON.parse(text.slice(jsonStart))
  }

  async function callTool(name: string, args: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> {
    const handler = registeredTools.get(name)
    if (!handler) throw new Error(`tool ${name} not registered`)
    return await handler(args) as { content: { text: string }[]; isError?: boolean }
  }

  describe('hutch_store_records', () => {
    it('includes url for the auto-created collection path', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(recordService.createRecords).mockResolvedValue({
        collection: { name: 'Bookmarks', slug: 'bookmarks' },
        action: 'created',
        record: { id: 1 },
        summary: 'Saved 1 record to Bookmarks',
      } as never)

      const result = await callTool('hutch_store_records', {
        collection: 'Bookmarks',
        data: { url: 'https://example.com' },
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/bookmarks`)
    })

    it('includes url for the existing-collection path', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(recordService.createRecords).mockResolvedValue({
        collection: { name: 'Users', slug: 'users' },
        action: 'replaced',
        record: { id: 2 },
      } as never)

      const result = await callTool('hutch_store_records', {
        collection: 'Users',
        data: { name: 'Bob' },
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/users`)
    })
  })

  describe('hutch_update_collection', () => {
    it('includes url with the slug from the input args', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(collectionService.updateCollection).mockResolvedValue({
        collection: { id: 1, name: 'Users', slug: 'users' },
      } as never)

      const result = await callTool('hutch_update_collection', {
        slug: 'users',
        name: 'People',
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/users`)
    })
  })

  describe('hutch_update_record', () => {
    it('includes url with the slug from the input args', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(recordService.updateRecord).mockResolvedValue({
        record: { id: 7, data: { name: 'Alice' } },
      } as never)

      const result = await callTool('hutch_update_record', {
        slug: 'users',
        record_id: 7,
        data: { name: 'Alice' },
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/users`)
    })
  })

  describe('hutch_transform_records', () => {
    it('includes url with the slug from the input args', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(recordService.transformRecords).mockResolvedValue({
        updated: 5,
      } as never)

      const result = await callTool('hutch_transform_records', {
        slug: 'users',
        remove_fields: ['legacy'],
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/users`)
    })
  })

  describe('hutch_set_record_status', () => {
    it('includes url with the slug from the input args', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(recordService.updateRecordStatus).mockResolvedValue({
        record: { id: 3, status: 'archived' },
      } as never)

      const result = await callTool('hutch_set_record_status', {
        slug: 'users',
        record_id: 3,
        status: 'archived',
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/users`)
    })
  })

  describe('hutch_delete_record', () => {
    it('includes url because the collection still exists', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(recordService.deleteRecord).mockResolvedValue({
        record: { id: 9 },
      } as never)

      const result = await callTool('hutch_delete_record', {
        slug: 'users',
        record_id: 9,
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/users`)
    })
  })

  describe('hutch_infer_schema', () => {
    it('includes url with the slug from the input args', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(collectionService.inferCollectionSchema).mockResolvedValue({
        fields: [{ name: 'title', type: 'text' }],
      } as never)

      const result = await callTool('hutch_infer_schema', { slug: 'notes' })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/notes`)
    })
  })

  describe('hutch_update_schema', () => {
    it('includes url with the slug from the input args', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(collectionService.updateFieldDefinition).mockResolvedValue({
        field: { name: 'status', type: 'select' },
      } as never)

      const result = await callTool('hutch_update_schema', {
        slug: 'tasks',
        field: 'status',
        type: 'select',
        options: ['todo', 'done'],
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/tasks`)
    })
  })

  describe('hutch_create_view', () => {
    it('includes url with the slug from the input args', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(createView).mockResolvedValue({
        view: { id: 1, name: 'Table' },
      } as never)

      const result = await callTool('hutch_create_view', {
        slug: 'tasks',
        type: 'table',
      })

      const parsed = parseResponseJson(result.content[0].text)
      expect(parsed.url).toBe(`${BASE_URL}/c/tasks`)
    })
  })

  describe('hutch_delete_collection', () => {
    it('does NOT include a url field because the collection no longer exists', async () => {
      createMcpServer('user-1', 'org-test', BASE_URL)
      vi.mocked(collectionService.deleteCollection).mockResolvedValue({
        deleted: true,
      } as never)

      const result = await callTool('hutch_delete_collection', { slug: 'users' })

      const text = result.content[0].text
      // Response is a plain confirmation string, not JSON — no url field anywhere.
      expect(text).not.toMatch(/"url"\s*:/)
      expect(text).not.toContain(`${BASE_URL}/c/users`)
    })
  })
})
