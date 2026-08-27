import { describe, it, expect } from 'vitest'
import { beforeCreateRecord } from './quota'

// The Cloud overlay replaces this module with real enforcement; Core only
// guarantees the seam exists and resolves.

describe('quota seam', () => {
  it('keeps the existing beforeCreateRecord no-op', async () => {
    await expect(
      beforeCreateRecord({
        userId: 'u1',
        organizationId: 'o1',
        collectionName: 'notes',
        count: 1,
        bytes: 10,
      })
    ).resolves.toBeUndefined()
  })
})

// Failing spec (TDD): the seam also exports the error class the Cloud overlay
// throws when an org exceeds its storage cap. Core never throws it, but the
// services need the class to detect and map it to a 413 response.
//
// Loaded via dynamic import so that, until the class exists, only these tests
// fail — the no-op seam tests above must keep passing.
describe('QuotaExceededError', () => {
  async function loadClass() {
    const mod = (await import('./quota')) as Record<string, unknown>
    return mod.QuotaExceededError as new (message?: string) => Error & { status: number }
  }

  it('is exported from the quota seam as a constructor', async () => {
    const QuotaExceededError = await loadClass()
    expect(typeof QuotaExceededError).toBe('function')
  })

  it('extends Error', async () => {
    const QuotaExceededError = await loadClass()
    const err = new QuotaExceededError('over cap')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(QuotaExceededError)
  })

  it('has status 413', async () => {
    const QuotaExceededError = await loadClass()
    expect(new QuotaExceededError('over cap').status).toBe(413)
  })

  it('has name "QuotaExceededError"', async () => {
    const QuotaExceededError = await loadClass()
    expect(new QuotaExceededError('over cap').name).toBe('QuotaExceededError')
  })

  it('carries the constructor message', async () => {
    const QuotaExceededError = await loadClass()
    expect(new QuotaExceededError('Storage quota exceeded for org o1').message).toBe(
      'Storage quota exceeded for org o1'
    )
  })
})
