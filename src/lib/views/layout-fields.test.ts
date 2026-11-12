import { describe, it, expect } from 'vitest'
import { LAYOUT_FIELD_KEYS, layoutField, layoutFieldKeys, publishableFields } from './layout-fields'

describe('layoutFieldKeys', () => {
  it('gives each layout type its keys, kanban in reader order', () => {
    expect(layoutFieldKeys('kanban')).toEqual(['groupField', 'groupByField'])
    expect(layoutFieldKeys('calendar')).toEqual(['dateField'])
    expect(layoutFieldKeys('timeline')).toEqual(['dateField'])
    expect(layoutFieldKeys('gallery')).toEqual(['imageField'])
    expect(layoutFieldKeys('table')).toEqual([])
  })

  it('gives none to a missing type or one that names an Object.prototype key', () => {
    for (const type of [null, undefined, '', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(layoutFieldKeys(type), String(type)).toEqual([])
      expect(layoutField(type, { dateField: 'due', groupField: 'status' }), String(type)).toBeUndefined()
    }
    expect(Object.keys(LAYOUT_FIELD_KEYS).sort()).toEqual(['calendar', 'gallery', 'kanban', 'timeline'])
  })
})

describe('layoutField', () => {
  it('reads the first key set to a non-empty string', () => {
    expect(layoutField('kanban', { groupField: 'priority', groupByField: 'status' })).toBe('priority')
    expect(layoutField('kanban', { groupField: '', groupByField: 'status' })).toBe('status')
    expect(layoutField('kanban', { groupField: null, groupByField: 'status' })).toBe('status')
    expect(layoutField('calendar', { dateField: 'due', imageField: 'cover' })).toBe('due')
    expect(layoutField('gallery', { imageField: 'cover' })).toBe('cover')
  })

  it('is undefined without a set key or a config object', () => {
    expect(layoutField('gallery', { dateField: 'due' })).toBeUndefined()
    expect(layoutField('kanban', { groupByField: 7 })).toBeUndefined()
    expect(layoutField('kanban', null)).toBeUndefined()
    expect(layoutField('kanban', 'groupField')).toBeUndefined()
  })

  it('ignores inherited keys', () => {
    expect(layoutField('calendar', Object.create({ dateField: 'due' }))).toBeUndefined()
  })
})

describe('publishableFields', () => {
  it('lists the saved schema fields that are not hidden, in schema order', () => {
    const schema = {
      fields: [
        { name: 'title', hidden: false },
        { name: 'secret', hidden: true },
        { name: 'due' },
        { name: 'flagged', hidden: 1 },
        { name: 'note', hidden: 0 },
        { type: 'text' },
        null,
        'loose',
      ],
    }
    expect(publishableFields(schema)).toEqual(['title', 'due', 'note'])
  })

  it('is empty without saved schema fields', () => {
    expect(publishableFields(null)).toEqual([])
    expect(publishableFields(undefined)).toEqual([])
    expect(publishableFields({})).toEqual([])
    expect(publishableFields({ fields: 'title' })).toEqual([])
  })
})
