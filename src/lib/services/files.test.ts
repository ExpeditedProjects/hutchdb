import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Failing spec (TDD) for src/lib/services/files.ts — files stored as records.
//
// A file IS a record whose `data` has the canonical shape:
//   { path, filename, mime_type, size, content_hash, content? | blob_key? }
//
// Two storage tiers:
//   INLINE — valid UTF-8, <= 262_144 bytes (MAX_INLINE_FILE_SIZE), text-like
//            mime (text/*, application/json, or unspecified) → `content` string
//            in the record JSON, no blob written.
//   BLOB   — everything else, up to 4_194_304 bytes (MAX_FILE_SIZE) → written
//            via the storage seam (src/lib/storage/seam.ts, S3-compatible),
//            record stores `blob_key` (no `content`).
//            Over 4MB → { error, status: 413 }.
//            Storage seam not configured (no HUTCH_S3_* env) → the seam ops
//            reject with a "storage not configured" error and putFile maps it
//            to { error, status: 501 }. Inline files never touch the seam and
//            keep working without any storage config.
//
// Blob downloads: getFile returns `download_url` = the presigned GET URL from
// storage.getDownloadUrl(blob_key) (async). There is no byte-streaming path.
// ---------------------------------------------------------------------------

const MAX_INLINE_FILE_SIZE = 262_144
const MAX_FILE_SIZE = 4_194_304

const {
  insertReturning,
  updateReturning,
  selectLimit,
  rowsHolder,
  storagePut,
  storageDelete,
  storageGetDownloadUrl,
  beforeStoreFile,
  releaseStorage,
  createRecordsMock,
} = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  updateReturning: vi.fn(),
  selectLimit: vi.fn(),
  rowsHolder: { rows: [] as unknown[] },
  storagePut: vi.fn(),
  storageDelete: vi.fn(),
  storageGetDownloadUrl: vi.fn(),
  beforeStoreFile: vi.fn(),
  releaseStorage: vi.fn(),
  createRecordsMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: insertReturning })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: updateReturning })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve(rowsHolder.rows), {
            limit: selectLimit,
            orderBy: vi.fn(() =>
              Object.assign(Promise.resolve(rowsHolder.rows), {
                limit: vi.fn(() =>
                  Object.assign(Promise.resolve(rowsHolder.rows), {
                    offset: vi.fn(() => Promise.resolve(rowsHolder.rows)),
                  })
                ),
              })
            ),
          })
        ),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    execute: vi.fn(),
  },
}))

vi.mock('@/lib/db/queries', () => ({
  findCollectionByNameInOrg: vi.fn(),
  findCollectionBySlugInOrg: vi.fn(),
  findAccessibleCollectionBySlug: vi.fn(),
  createCollectionWithOwner: vi.fn(),
  getCollectionRecordCount: vi.fn().mockResolvedValue(0),
  queryRecords: vi.fn(),
  notDeleted: { __notDeleted: true },
}))

vi.mock('@/lib/storage/seam', () => ({
  getStorage: vi.fn(() => ({
    put: storagePut,
    delete: storageDelete,
    getDownloadUrl: storageGetDownloadUrl,
  })),
}))

// Partial mock: the hooks are replaced with controllable fns, but the module's
// other exports (notably the real QuotaExceededError class) are kept so
// instanceof detection in the service works.
vi.mock('@/lib/quota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quota')>()),
  beforeCreateRecord: vi.fn().mockResolvedValue(undefined),
  beforeStoreFile,
  releaseStorage,
}))

vi.mock('./records', () => ({
  createRecords: createRecordsMock,
}))

vi.mock('@/lib/revalidation', () => ({
  revalidateDashboard: vi.fn(),
}))

import { putFile, getFile, listFiles, deleteFile, cleanupCollectionBlobs } from './files'
import {
  findCollectionByNameInOrg,
  findCollectionBySlugInOrg,
  findAccessibleCollectionBySlug,
  createCollectionWithOwner,
} from '@/lib/db/queries'

const sha256 = (input: string | Uint8Array) =>
  createHash('sha256').update(input).digest('hex')

const fileCollection = {
  id: 1,
  apiKeyId: 1,
  organizationId: 'org-test',
  name: 'Agent Files',
  slug: 'agent-files',
  uniqueKey: ['path'],
  schema: { fields: [], version: 1, lastInferredAt: new Date().toISOString() },
  description: null,
  published: false,
  publishedAt: null,
  visibility: 'private',
  orgDefaultRole: 'viewer',
  createdAt: new Date(),
  updatedAt: new Date(),
}

const mockOrg = {
  id: 'org-test',
  slug: 'test',
  name: 'Test',
  personal: false,
  callerRole: 'admin' as const,
}

function putParams(overrides: Record<string, unknown> = {}) {
  return {
    collection: 'agent-files',
    path: 'CLAUDE.md',
    content: 'hello world',
    mimeType: 'text/markdown',
    ...overrides,
  }
}

// The `data` object handed to createRecords for the last putFile call.
function lastCreateRecordsData(): Record<string, unknown> {
  const call = createRecordsMock.mock.calls.at(-1)
  expect(call, 'expected createRecords to have been called').toBeDefined()
  const params = call![2] as { data?: Record<string, unknown> }
  expect(params.data, 'expected createRecords to receive a single data object').toBeDefined()
  return params.data!
}

beforeEach(() => {
  vi.clearAllMocks()
  rowsHolder.rows = []
  selectLimit.mockResolvedValue([])
  storagePut.mockResolvedValue(undefined)
  storageDelete.mockResolvedValue(undefined)
  storageGetDownloadUrl.mockResolvedValue(
    'https://s3.example.test/hutch-blobs/blobs/1/abc?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig'
  )
  beforeStoreFile.mockResolvedValue(undefined)
  releaseStorage.mockResolvedValue(undefined)
  vi.mocked(findCollectionByNameInOrg).mockResolvedValue(fileCollection as never)
  vi.mocked(findCollectionBySlugInOrg).mockResolvedValue(fileCollection as never)
  createRecordsMock.mockResolvedValue({
    collection: { name: 'Agent Files', slug: 'agent-files' },
    action: 'created',
    record: { id: 1 },
  })
})

describe('putFile — input validation', () => {
  it('returns 400 when neither content nor contentBase64 is provided', async () => {
    const result = await putFile('user-test', 'org-test', {
      collection: 'agent-files',
      path: 'CLAUDE.md',
    })
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
    expect(createRecordsMock).not.toHaveBeenCalled()
    expect(storagePut).not.toHaveBeenCalled()
  })

  it('returns 400 when both content and contentBase64 are provided', async () => {
    const result = await putFile('user-test', 'org-test', putParams({
      contentBase64: Buffer.from('hello').toString('base64'),
    }))
    expect(result).toEqual(expect.objectContaining({ status: 400 }))
    expect(createRecordsMock).not.toHaveBeenCalled()
  })

  describe('path validation (400, nothing persisted)', () => {
    const badPaths: [string, string][] = [
      ['empty path', ''],
      ['absolute path', '/etc/passwd'],
      ['leading .. segment', '../secrets.md'],
      ['embedded .. segment', 'prompts/../../escape.md'],
      ['trailing .. segment', 'prompts/..'],
      ['bare ..', '..'],
      ['null byte', 'evil\0.md'],
      ['longer than 512 chars', 'a'.repeat(513)],
    ]

    for (const [label, path] of badPaths) {
      it(`rejects ${label}`, async () => {
        const result = await putFile('user-test', 'org-test', putParams({ path }))
        expect(result).toEqual(expect.objectContaining({ status: 400 }))
        expect(createRecordsMock).not.toHaveBeenCalled()
        expect(storagePut).not.toHaveBeenCalled()
      })
    }

    it('accepts a path of exactly 512 chars', async () => {
      const result = await putFile('user-test', 'org-test', putParams({ path: 'a'.repeat(512) }))
      expect(result).not.toEqual(expect.objectContaining({ status: 400 }))
      expect(createRecordsMock).toHaveBeenCalled()
    })
  })

  it('returns 413 when string content exceeds MAX_FILE_SIZE (4MB)', async () => {
    const result = await putFile('user-test', 'org-test', putParams({
      content: 'a'.repeat(MAX_FILE_SIZE + 1),
      mimeType: 'text/plain',
    }))
    expect(result).toEqual(expect.objectContaining({ status: 413 }))
    expect(storagePut).not.toHaveBeenCalled()
    expect(createRecordsMock).not.toHaveBeenCalled()
  })

  it('returns 413 when base64 content decodes to more than 4MB', async () => {
    const result = await putFile('user-test', 'org-test', putParams({
      content: undefined,
      contentBase64: Buffer.alloc(MAX_FILE_SIZE + 1).toString('base64'),
      mimeType: 'application/octet-stream',
    }))
    expect(result).toEqual(expect.objectContaining({ status: 413 }))
    expect(storagePut).not.toHaveBeenCalled()
    expect(createRecordsMock).not.toHaveBeenCalled()
  })
})

describe('putFile — inline tier', () => {
  it('stores small UTF-8 text with a text/* mime inline (content in record, no blob)', async () => {
    await putFile('user-test', 'org-test', putParams())

    expect(createRecordsMock).toHaveBeenCalledWith('user-test', 'org-test', expect.objectContaining({
      collection: 'agent-files',
      on_conflict: 'replace',
    }))
    const data = lastCreateRecordsData()
    expect(data).toEqual(expect.objectContaining({
      path: 'CLAUDE.md',
      filename: 'CLAUDE.md',
      mime_type: 'text/markdown',
      size: Buffer.byteLength('hello world'),
      content_hash: sha256('hello world'),
      content: 'hello world',
    }))
    expect(data).not.toHaveProperty('blob_key')
    expect(storagePut).not.toHaveBeenCalled()
  })

  it('treats application/json as text-like (inline)', async () => {
    await putFile('user-test', 'org-test', putParams({
      path: 'config.json',
      content: '{"a":1}',
      mimeType: 'application/json',
    }))
    const data = lastCreateRecordsData()
    expect(data.content).toBe('{"a":1}')
    expect(data).not.toHaveProperty('blob_key')
    expect(storagePut).not.toHaveBeenCalled()
  })

  it('treats unspecified mime with UTF-8 content as text-like (inline)', async () => {
    await putFile('user-test', 'org-test', {
      collection: 'agent-files',
      path: 'notes.txt',
      content: 'plain notes',
    })
    const data = lastCreateRecordsData()
    expect(data.content).toBe('plain notes')
    expect(data).not.toHaveProperty('blob_key')
    expect(storagePut).not.toHaveBeenCalled()
  })

  it('derives filename as the basename of a nested path', async () => {
    await putFile('user-test', 'org-test', putParams({ path: 'prompts/reviewer.md' }))
    const data = lastCreateRecordsData()
    expect(data.path).toBe('prompts/reviewer.md')
    expect(data.filename).toBe('reviewer.md')
  })

  it('computes size as UTF-8 byte length, not character count', async () => {
    await putFile('user-test', 'org-test', putParams({ content: 'héllo' }))
    const data = lastCreateRecordsData()
    expect(data.size).toBe(6) // 'héllo' is 5 chars, 6 bytes
    expect(data.content_hash).toBe(sha256(Buffer.from('héllo', 'utf8')))
  })

  it('keeps content exactly at MAX_INLINE_FILE_SIZE (256KB) inline', async () => {
    await putFile('user-test', 'org-test', putParams({
      content: 'a'.repeat(MAX_INLINE_FILE_SIZE),
      mimeType: 'text/plain',
    }))
    const data = lastCreateRecordsData()
    expect(data.content).toBeDefined()
    expect(data).not.toHaveProperty('blob_key')
    expect(storagePut).not.toHaveBeenCalled()
  })
})

describe('putFile — blob tier', () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const pngBase64 = Buffer.from(pngBytes).toString('base64')

  it('routes binary base64 content to the storage driver and stores blob_key', async () => {
    await putFile('user-test', 'org-test', {
      collection: 'agent-files',
      path: 'logo.png',
      contentBase64: pngBase64,
      mimeType: 'image/png',
    })

    expect(storagePut).toHaveBeenCalledTimes(1)
    const [key, bytes, contentType] = storagePut.mock.calls[0]
    expect(typeof key).toBe('string')
    expect(Buffer.from(bytes as Uint8Array).equals(Buffer.from(pngBytes))).toBe(true)
    expect(contentType).toBe('image/png')

    const data = lastCreateRecordsData()
    expect(data).toEqual(expect.objectContaining({
      path: 'logo.png',
      filename: 'logo.png',
      mime_type: 'image/png',
      size: pngBytes.length,
      content_hash: sha256(pngBytes),
      blob_key: key,
    }))
    expect(data).not.toHaveProperty('content')
  })

  it('routes text over MAX_INLINE_FILE_SIZE to the blob tier even when UTF-8', async () => {
    const big = 'a'.repeat(MAX_INLINE_FILE_SIZE + 1)
    await putFile('user-test', 'org-test', putParams({ content: big, mimeType: 'text/plain' }))

    expect(storagePut).toHaveBeenCalledTimes(1)
    const data = lastCreateRecordsData()
    expect(data.blob_key).toBeDefined()
    expect(data).not.toHaveProperty('content')
  })

  it('routes small UTF-8 content with a non-text mime to the blob tier', async () => {
    await putFile('user-test', 'org-test', putParams({
      path: 'anim.gif',
      content: 'GIF89a',
      mimeType: 'image/gif',
    }))
    expect(storagePut).toHaveBeenCalledTimes(1)
    const data = lastCreateRecordsData()
    expect(data.blob_key).toBeDefined()
    expect(data).not.toHaveProperty('content')
  })

  it('accepts a blob of exactly MAX_FILE_SIZE (4MB)', async () => {
    const result = await putFile('user-test', 'org-test', putParams({
      content: 'a'.repeat(MAX_FILE_SIZE),
      mimeType: 'text/plain',
    }))
    expect(result).not.toEqual(expect.objectContaining({ status: 413 }))
    expect(storagePut).toHaveBeenCalledTimes(1)
  })

  it('calls the beforeStoreFile quota seam before writing the blob', async () => {
    await putFile('user-test', 'org-test', {
      collection: 'agent-files',
      path: 'logo.png',
      contentBase64: pngBase64,
      mimeType: 'image/png',
    })

    expect(beforeStoreFile).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-test',
      organizationId: 'org-test',
      bytes: pngBytes.length,
    }))
    expect(beforeStoreFile.mock.invocationCallOrder[0]).toBeLessThan(
      storagePut.mock.invocationCallOrder[0]
    )
  })
})

describe('putFile — storage not configured (no HUTCH_S3_* env)', () => {
  // The seam is the source of truth: its ops reject when the env is absent.
  const notConfigured = new Error(
    'Blob storage is not configured. Set the HUTCH_S3_* environment variables.'
  )

  beforeEach(() => {
    storagePut.mockRejectedValue(notConfigured)
    storageDelete.mockRejectedValue(notConfigured)
    storageGetDownloadUrl.mockRejectedValue(notConfigured)
  })

  it('blob-tier putFile returns a clear 501 error and persists nothing', async () => {
    const result = await putFile('user-test', 'org-test', {
      collection: 'agent-files',
      path: 'logo.png',
      contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png',
    })

    expect(result).toEqual(expect.objectContaining({ status: 501 }))
    expect((result as { error: string }).error).toMatch(/not configured/i)
    expect(createRecordsMock).not.toHaveBeenCalled()
  })

  it('inline putFile still succeeds without any storage config', async () => {
    const result = await putFile('user-test', 'org-test', putParams())

    expect(result).toEqual(expect.objectContaining({
      path: 'CLAUDE.md',
      content_hash: sha256('hello world'),
    }))
    expect(storagePut).not.toHaveBeenCalled()
    expect(createRecordsMock).toHaveBeenCalled()
  })
})

describe('putFile — quota exceeded (Cloud overlay throws QuotaExceededError)', () => {
  // Failing spec (TDD): the Cloud overlay's beforeStoreFile throws
  // QuotaExceededError when the org is over its storage cap. putFile must map
  // that rejection to { error, status: 413 } instead of throwing, and must not
  // write the blob or the record. beforeStoreFile only runs on the blob tier,
  // so the input here is binary base64 with a non-text mime.
  //
  // QuotaExceededError is referenced via dynamic import so that, until the
  // class exists, only these tests fail — the rest of this file must pass.
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const pngBase64 = Buffer.from(pngBytes).toString('base64')

  async function makeQuotaError(message: string): Promise<Error> {
    const mod = (await import('@/lib/quota')) as unknown as {
      QuotaExceededError: new (message?: string) => Error
    }
    return new mod.QuotaExceededError(message)
  }

  it('maps a QuotaExceededError from beforeStoreFile to { error: <message>, status: 413 }', async () => {
    beforeStoreFile.mockRejectedValueOnce(
      await makeQuotaError('Storage quota exceeded for this organization')
    )

    const result = await putFile('user-test', 'org-test', {
      collection: 'agent-files',
      path: 'logo.png',
      contentBase64: pngBase64,
      mimeType: 'image/png',
    })

    expect(result).toEqual({
      error: 'Storage quota exceeded for this organization',
      status: 413,
    })
  })

  it('writes no blob and creates no record after the quota rejection', async () => {
    beforeStoreFile.mockRejectedValueOnce(
      await makeQuotaError('Storage quota exceeded for this organization')
    )

    await putFile('user-test', 'org-test', {
      collection: 'agent-files',
      path: 'logo.png',
      contentBase64: pngBase64,
      mimeType: 'image/png',
    })

    expect(storagePut).not.toHaveBeenCalled()
    expect(createRecordsMock).not.toHaveBeenCalled()
  })
})

describe('putFile — collection auto-create', () => {
  it('auto-creates a missing collection with uniqueKey ["path"] and a file-typed schema field', async () => {
    vi.mocked(findCollectionByNameInOrg).mockResolvedValue(undefined as never)
    vi.mocked(findCollectionBySlugInOrg).mockResolvedValue(undefined as never)
    vi.mocked(createCollectionWithOwner).mockResolvedValue({
      ...fileCollection,
      name: 'Prompts',
      slug: 'prompts-aaaaaaaa',
    } as never)

    await putFile('user-test', 'org-test', putParams({ collection: 'prompts' }))

    expect(createCollectionWithOwner).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-test',
      ownerUserId: 'user-test',
      uniqueKey: ['path'],
    }))
    const call = vi.mocked(createCollectionWithOwner).mock.calls[0][0] as {
      schema?: { fields: { type: string }[] }
    }
    expect(call.schema?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'file' })])
    )
  })

  it('does not create a collection when one already exists', async () => {
    await putFile('user-test', 'org-test', putParams())
    expect(createCollectionWithOwner).not.toHaveBeenCalled()
  })
})

describe('putFile — last-write-wins replace and blob supersede', () => {
  const oldBlobRecord = {
    id: 7,
    collectionId: 1,
    data: {
      path: 'CLAUDE.md',
      filename: 'CLAUDE.md',
      mime_type: 'application/octet-stream',
      size: 1024,
      content_hash: 'deadbeef'.repeat(8),
      blob_key: 'blobs/1/old-key',
    },
    deletedAt: null,
  }

  it('deletes the superseded blob and releases storage when content_hash changes', async () => {
    selectLimit.mockResolvedValue([oldBlobRecord])
    rowsHolder.rows = [oldBlobRecord]

    await putFile('user-test', 'org-test', putParams({ content: 'brand new content' }))

    expect(storageDelete).toHaveBeenCalledWith(['blobs/1/old-key'])
    expect(releaseStorage).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-test',
      bytes: 1024,
    }))
  })

  it('does not delete the blob or release storage when content_hash is unchanged', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const existing = {
      ...oldBlobRecord,
      data: {
        ...oldBlobRecord.data,
        size: bytes.length,
        content_hash: sha256(bytes),
        mime_type: 'application/octet-stream',
      },
    }
    selectLimit.mockResolvedValue([existing])
    rowsHolder.rows = [existing]

    await putFile('user-test', 'org-test', {
      collection: 'agent-files',
      path: 'CLAUDE.md',
      contentBase64: Buffer.from(bytes).toString('base64'),
      mimeType: 'application/octet-stream',
    })

    expect(storageDelete).not.toHaveBeenCalled()
    expect(releaseStorage).not.toHaveBeenCalled()
  })

  it('does not touch storage when the replaced record was inline', async () => {
    const inlineRecord = {
      id: 8,
      collectionId: 1,
      data: {
        path: 'CLAUDE.md',
        filename: 'CLAUDE.md',
        mime_type: 'text/markdown',
        size: 3,
        content_hash: sha256('old'),
        content: 'old',
      },
      deletedAt: null,
    }
    selectLimit.mockResolvedValue([inlineRecord])
    rowsHolder.rows = [inlineRecord]

    await putFile('user-test', 'org-test', putParams({ content: 'new' }))

    expect(storageDelete).not.toHaveBeenCalled()
    expect(releaseStorage).not.toHaveBeenCalled()
  })
})

describe('putFile — return value', () => {
  it('returns file metadata and never echoes the content', async () => {
    const result = await putFile('user-test', 'org-test', putParams())

    expect(result).toEqual(expect.objectContaining({
      path: 'CLAUDE.md',
      size: Buffer.byteLength('hello world'),
      mime_type: 'text/markdown',
      content_hash: sha256('hello world'),
    }))
    expect(result).not.toHaveProperty('content')
  })
})

describe('getFile', () => {
  const inlineRecord = {
    id: 10,
    collectionId: 1,
    data: {
      path: 'CLAUDE.md',
      filename: 'CLAUDE.md',
      mime_type: 'text/markdown',
      size: 11,
      content_hash: sha256('hello world'),
      content: 'hello world',
    },
    deletedAt: null,
  }

  const blobRecord = {
    id: 11,
    collectionId: 1,
    data: {
      path: 'prompts/reviewer.md',
      filename: 'reviewer.md',
      mime_type: 'image/png',
      size: 8,
      content_hash: 'ab'.repeat(32),
      blob_key: 'blobs/1/abc',
    },
    deletedAt: null,
  }

  it('returns null when the caller has no access to the collection', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await getFile('agent-files', 'user-test', 'CLAUDE.md')
    expect(result).toBeNull()
  })

  it('returns a 404-style error when no active file record matches the path', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg, collection: fileCollection, role: 'viewer',
    } as never)
    selectLimit.mockResolvedValue([])
    rowsHolder.rows = []

    const result = await getFile('agent-files', 'user-test', 'missing.md')
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
  })

  it('returns metadata plus content for an inline file', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg, collection: fileCollection, role: 'viewer',
    } as never)
    selectLimit.mockResolvedValue([inlineRecord])
    rowsHolder.rows = [inlineRecord]

    const result = await getFile('agent-files', 'user-test', 'CLAUDE.md')
    expect(result).toEqual(expect.objectContaining({
      path: 'CLAUDE.md',
      filename: 'CLAUDE.md',
      mime_type: 'text/markdown',
      size: 11,
      content: 'hello world',
    }))
    expect((result as Record<string, unknown>).download_url).toBeUndefined()
  })

  it('returns metadata plus the presigned download_url (no content) for a blob file', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg, collection: fileCollection, role: 'viewer',
    } as never)
    selectLimit.mockResolvedValue([blobRecord])
    rowsHolder.rows = [blobRecord]
    const presigned =
      'https://s3.example.test/hutch-blobs/blobs/1/abc?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig'
    storageGetDownloadUrl.mockResolvedValue(presigned)

    const result = await getFile('agent-files', 'user-test', 'prompts/reviewer.md')
    expect(storageGetDownloadUrl).toHaveBeenCalledWith('blobs/1/abc')
    expect(result).toEqual(expect.objectContaining({
      path: 'prompts/reviewer.md',
      mime_type: 'image/png',
      download_url: presigned,
    }))
    expect(result).not.toHaveProperty('content')
  })
})

describe('listFiles', () => {
  it('returns null when the caller has no access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await listFiles('agent-files', 'user-test')
    expect(result).toBeNull()
  })

  it('returns metadata for active file records only, with no content field', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg, collection: fileCollection, role: 'viewer',
    } as never)
    const rows = [
      {
        id: 1,
        collectionId: 1,
        data: {
          path: 'CLAUDE.md', filename: 'CLAUDE.md', mime_type: 'text/markdown',
          size: 11, content_hash: sha256('hello world'), content: 'hello world',
        },
        deletedAt: null,
      },
      {
        id: 2,
        collectionId: 1,
        data: {
          path: 'logo.png', filename: 'logo.png', mime_type: 'image/png',
          size: 8, content_hash: 'ab'.repeat(32), blob_key: 'blobs/1/abc',
        },
        deletedAt: null,
      },
    ]
    rowsHolder.rows = rows
    selectLimit.mockResolvedValue(rows)

    const result = await listFiles('agent-files', 'user-test')
    expect(result).toEqual(expect.objectContaining({
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'CLAUDE.md', mime_type: 'text/markdown', size: 11 }),
        expect.objectContaining({ path: 'logo.png', mime_type: 'image/png', size: 8 }),
      ]),
    }))
    const files = (result as { files: Record<string, unknown>[] }).files
    expect(files).toHaveLength(2)
    for (const file of files) {
      expect(file).not.toHaveProperty('content')
    }
  })
})

describe('deleteFile', () => {
  it('returns null when the caller has no editor access', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue(undefined as never)
    const result = await deleteFile('agent-files', 'user-test', 'CLAUDE.md')
    expect(result).toBeNull()
  })

  it('returns a 404-style error when no active file record matches the path', async () => {
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg, collection: fileCollection, role: 'editor',
    } as never)
    selectLimit.mockResolvedValue([])
    rowsHolder.rows = []

    const result = await deleteFile('agent-files', 'user-test', 'missing.md')
    expect(result).toEqual(expect.objectContaining({ status: 404 }))
  })

  it('soft-deletes the record and RETAINS the blob (restorable)', async () => {
    const blobRecord = {
      id: 11,
      collectionId: 1,
      data: {
        path: 'logo.png', filename: 'logo.png', mime_type: 'image/png',
        size: 8, content_hash: 'ab'.repeat(32), blob_key: 'blobs/1/abc',
      },
      deletedAt: null,
    }
    vi.mocked(findAccessibleCollectionBySlug).mockResolvedValue({
      organization: mockOrg, collection: fileCollection, role: 'editor',
    } as never)
    selectLimit.mockResolvedValue([blobRecord])
    rowsHolder.rows = [blobRecord]

    const result = await deleteFile('agent-files', 'user-test', 'logo.png')

    expect(result).toEqual(expect.objectContaining({ deleted: true, path: 'logo.png' }))
    const { db } = await import('@/lib/db')
    expect(vi.mocked(db.update)).toHaveBeenCalled() // soft delete via deletedAt
    expect(vi.mocked(db.delete)).not.toHaveBeenCalled() // no hard delete
    expect(storageDelete).not.toHaveBeenCalled() // blob retained
    expect(releaseStorage).not.toHaveBeenCalled()
  })
})

describe('cleanupCollectionBlobs', () => {
  it('deletes the blobs of ALL records including soft-deleted ones', async () => {
    rowsHolder.rows = [
      { id: 1, collectionId: 1, data: { path: 'a.png', blob_key: 'blobs/1/a' }, deletedAt: null },
      { id: 2, collectionId: 1, data: { path: 'b.md', content: 'inline only' }, deletedAt: null },
      { id: 3, collectionId: 1, data: { path: 'c.png', blob_key: 'blobs/1/c' }, deletedAt: new Date() },
    ]

    await cleanupCollectionBlobs(1)

    expect(storageDelete).toHaveBeenCalledTimes(1)
    const keys = storageDelete.mock.calls[0][0] as string[]
    expect(keys).toEqual(expect.arrayContaining(['blobs/1/a', 'blobs/1/c']))
    expect(keys).toHaveLength(2)
  })

  it('does not call the storage driver when the collection has no blobs', async () => {
    rowsHolder.rows = [
      { id: 1, collectionId: 1, data: { path: 'b.md', content: 'inline only' }, deletedAt: null },
    ]

    await cleanupCollectionBlobs(1)

    expect(storageDelete).not.toHaveBeenCalled()
  })
})
