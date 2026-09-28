import { describe, it, expect, vi, afterEach } from 'vitest'

// config parses process.env at module load, so re-import it per scenario.
async function loadDbUrl(): Promise<string | undefined> {
  vi.resetModules()
  const { config } = await import('./config')
  return config.db.url
}

describe('config.db.url', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers HUTCH_DATABASE_URL over DATABASE_URL', async () => {
    vi.stubEnv('HUTCH_DATABASE_URL', 'postgres://hutch/primary')
    vi.stubEnv('DATABASE_URL', 'postgres://host/fallback')

    expect(await loadDbUrl()).toBe('postgres://hutch/primary')
  })

  it('falls back to DATABASE_URL when HUTCH_DATABASE_URL is unset', async () => {
    vi.stubEnv('HUTCH_DATABASE_URL', '')
    vi.stubEnv('DATABASE_URL', 'postgres://host/fallback')

    expect(await loadDbUrl()).toBe('postgres://host/fallback')
  })
})
