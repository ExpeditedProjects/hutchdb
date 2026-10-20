import { describe, it, expect, afterEach } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { classifyDbError, describeDbError, findPgError, formatTimeout, statementTimeoutMs, timeoutAdvice } from './errors'

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

  it('never claims a retry is bound to fail, for any tool', () => {
    for (const tool of ['hutch_query_records', 'hutch_export_records', 'hutch_search', 'hutch_describe_collection', 'hutch_collection_stats', 'hutch_get_collection', 'hutch_list_collections']) {
      for (const args of [{}, { group_by: 'status' }]) {
        expect(describeDbError(wrapped('57014', 'x'), { tool, args })).not.toMatch(/will time out again|always time out/)
      }
    }
  })

  it('fits the advice to the tool and the query shape', () => {
    const grouped = timeoutAdvice('hutch_query_records', { group_by: 'status', aggregate: { n: 'count' } })
    expect(grouped).toMatch(/^Grouped and aggregate queries read every record the filter matches/)
    expect(grouped).toMatch(/indexed field/)
    expect(timeoutAdvice('hutch_query_records', { time_bucket: { field: 'ts', interval: 'day' } })).toMatch(/^Grouped and aggregate/)
    expect(timeoutAdvice('hutch_query_records', { filter: { a: 1 } })).toMatch(/^Narrow the filter.*limit: 0/)
    expect(timeoutAdvice('hutch_export_records')).toMatch(/export fewer records \(limit\)/)
    expect(timeoutAdvice('hutch_export_records')).not.toMatch(/limit: 0/)
    expect(timeoutAdvice('hutch_search')).toMatch(/hutch_query_records with search/)
    expect(timeoutAdvice('hutch_describe_collection')).not.toMatch(/filter|limit: 0/)
    expect(timeoutAdvice('hutch_collection_stats')).not.toMatch(/filter|fields;/)
    expect(timeoutAdvice('hutch_get_collection')).toMatch(/may succeed when the server is less busy/)
  })

  it('gives batching advice for writes', () => {
    const text = describeDbError(wrapped('57014', 'x'), { tool: 'hutch_store_records', collection: 'orders', write: true })
    expect(text).toMatch(/^hutch_store_records timed out after 5s on collection 'orders'\. Send smaller batches/)
  })

  it('reports the configured statement timeout', () => {
    process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS = '2500'
    expect(statementTimeoutMs()).toBe(2500)
    expect(describeDbError(wrapped('57014', 'x'), { tool: 't' })).toMatch(/timed out after 2\.5s\./)
    expect(formatTimeout(800)).toBe('800ms')
  })

  it('reports 0 when HUTCH_DB_STATEMENT_TIMEOUT_MS=0 turns the timeout off, and formats that sensibly', () => {
    process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS = '0'
    expect(statementTimeoutMs()).toBe(0)
    expect(formatTimeout()).toBe('the time limit')
    expect(describeDbError(wrapped('57014', 'x'), { tool: 't' })).toMatch(/^t timed out after the time limit\./)
    process.env.HUTCH_DB_STATEMENT_TIMEOUT_MS = 'nope'
    expect(statementTimeoutMs()).toBe(5000)
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
