import { describe, it, expect } from 'vitest'
import { splitPassword } from './pg-url'

describe('splitPassword (storage:cutover pg_dump argv)', () => {
  it('moves a userinfo password out of the URL', () => {
    const out = splitPassword('postgresql://hutch:s3cr%40t@db.example:5432/hutch?sslmode=require')
    expect(out.password).toBe('s3cr@t')
    expect(out.url).toBe('postgresql://hutch@db.example:5432/hutch?sslmode=require')
    expect(out.url).not.toContain('s3cr')
  })

  it('moves a ?password= parameter out of the URL', () => {
    const out = splitPassword('postgresql://hutch@db.example/hutch?password=pw%26x&sslmode=require')
    expect(out.password).toBe('pw&x')
    expect(out.url).toBe('postgresql://hutch@db.example/hutch?sslmode=require')
  })

  it('leaves a password-free URL alone', () => {
    expect(splitPassword('postgresql://localhost/hutch')).toEqual({ url: 'postgresql://localhost/hutch', password: undefined })
  })

  it('returns an unparseable string unchanged', () => {
    expect(splitPassword('not a url')).toEqual({ url: 'not a url', password: undefined })
  })
})
