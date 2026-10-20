import { describe, it, expect, afterEach } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { classifyDbError, describeDbError, findPgError, formatTimeout, statementTimeoutMs } from './errors'

/** A node-postgres DatabaseError as drizzle wraps it. */
function pgError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; severity: string }
  err.code = code
  err.severity = 'ERROR'
  return err
}

function wrapped(code: string, message: string): DrizzleQueryError {
  return new DrizzleQueryError('SELECT * FROM hc_12 t WHERE t.data @> $1', ['{"secret":"hunter2"}'], pgError(code, message))
}

const LEAKS = [/hc_\d+/, /SELECT/, /hunter2/, /params/, /postgres(ql)?:\/\//i, /Failed query/]

describe('findPgError / classifyDbError', () => {
  it('finds the SQLSTATE on a drizzle-wrapped error and deeper cause chains', () => {
    expect(findPgError(wrapped('57014', 'canceling statement due to statement timeout'))?.code).toBe('57014')
    const step = Object.assign(new Error('transform set_field failed'), { cause: wrapped('22P02', 'bad') })
    expect(findPgError(step)?.code).toBe('22P02')
    expect(findPgError(new Error('plain'))).toBeNull()
  })

  it('classifies timeouts, invalid input and everything else', () => {
    expect(classifyDbError(wrapped('57014', 'canceling statement due to statement timeout'))).toBe('timeout')
    for (const code of ['22P02', '22007', '22008', '22003', '42804']) {
      expect(classifyDbError(wrapped(code, 'x'))).toBe('invalid_input')
    }
    expect(classifyDbError(wrapped('42P01', 'relation "hc_12" does not exist'))).toBe('other')
    expect(classifyDbError(new Error('Failed query: SELECT 1'))).toBe('other')
  })
})

describe('describeDbError', () => {
  afterEach(() => { delete process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS })

  it('says a statement timed out, after how long, on which collection, and what to change', () => {
    const text = describeDbError(wrapped('57014', 'canceling statement due to statement timeout'), { tool: 'hutch_query_records', collection: 'articles' })
    expect(text).toMatch(/^hutch_query_records timed out after 5s on collection 'articles'\./)
    expect(text).toMatch(/Narrow the filter/)
    expect(text).toMatch(/limit: 0/)
    expect(text).toMatch(/fewer fields/)
    for (const leak of LEAKS) expect(text).not.toMatch(leak)
  })

  it('reports the configured statement timeout', () => {
    process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS = '2500'
    expect(statementTimeoutMs()).toBe(2500)
    expect(describeDbError(wrapped('57014', 'x'), { tool: 't' })).toMatch(/timed out after 2\.5s\./)
    expect(formatTimeout(800)).toBe('800ms')
  })

  it('appends a timeout hint when one is given', () => {
    const text = describeDbError(wrapped('57014', 'x'), { tool: 't', collection: 'c', timeoutHint: 'Index builds failed.' })
    expect(text.endsWith(' Index builds failed.')).toBe(true)
  })

  it('says a value did not match a type, naming the Postgres type but never the value or SQL', () => {
    const err = wrapped('22007', 'invalid input syntax for type timestamp with time zone: "last tuesday"')
    const text = describeDbError(err, { tool: 'hutch_query_records', collection: 'events' })
    expect(text).toMatch(/does not match the type/)
    expect(text).toMatch(/expected timestamp with time zone/)
    expect(text).not.toMatch(/last tuesday/)
    for (const leak of LEAKS) expect(text).not.toMatch(leak)
  })

  it('keeps the generic message for any other database failure', () => {
    const text = describeDbError(wrapped('42P01', 'relation "hc_12" does not exist'), { tool: 'hutch_get_collection', collection: 'x' })
    expect(text).toBe('hutch_get_collection failed while accessing the database. Try again or adjust the inputs.')
  })
})
