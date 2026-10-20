import { describe, it, expect } from 'vitest'
import { splitToolText } from './cli-output'

describe('splitToolText', () => {
  it('passes plain JSON through as json', () => {
    expect(splitToolText('{"records": [], "total": 0}')).toEqual({ human: '', json: '{"records": [], "total": 0}' })
    expect(splitToolText('[1, 2]\n')).toEqual({ human: '', json: '[1, 2]' })
  })

  it('splits a write tool summary line from its JSON', () => {
    const text = 'Saved 2 records to Notes\n\n{\n  "count": 2\n}'
    expect(splitToolText(text)).toEqual({ human: 'Saved 2 records to Notes', json: '{\n  "count": 2\n}' })
  })

  it('keeps several human lines together', () => {
    expect(splitToolText('Line one\nLine two\n\n{"ok": true}')).toEqual({ human: 'Line one\nLine two', json: '{"ok": true}' })
  })

  it('returns non-JSON text as human only', () => {
    expect(splitToolText('Collection not found')).toEqual({ human: 'Collection not found', json: null })
    expect(splitToolText('note\n\n{not json')).toEqual({ human: 'note\n\n{not json', json: null })
  })
})
