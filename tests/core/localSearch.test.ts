import { describe, expect, it } from 'vitest'
import {
  tokenize,
  tokenizeAndStem,
  computeWeightedTf,
  computeIdf,
  cosineSimilarity,
  normalizeName,
  splitHyphenatedName,
  applyCjkFilter,
  buildQueryTfIdf,
  getQueryTokenSeparators,
  STOP_WORDS,
} from '../../src/core/localSearch.js'

describe('tokenize', () => {
  it('lowercases and splits ASCII words', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world'])
  })

  it('strips leading/trailing hyphens and underscores', () => {
    expect(tokenize('-foo-_bar-')).toEqual(['foo-_bar'])
  })

  it('removes stop words', () => {
    expect(tokenize('the cat is on a mat')).toEqual(['cat', 'mat'])
  })

  it('emits CJK bigrams', () => {
    expect(tokenize('测试代码')).toEqual(['测试', '试代', '代码'])
  })

  it('handles mixed ASCII + CJK', () => {
    const tokens = tokenize('hello 测试 code')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('测试')
    expect(tokens).toContain('code')
  })

  it('returns empty array on empty input', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('tokenizeAndStem', () => {
  it('strips -ing suffix', () => {
    expect(tokenizeAndStem('running')).toEqual(['runn'])
  })

  it('strips -tion suffix', () => {
    expect(tokenizeAndStem('creation')).toEqual(['crea'])
  })

  it('strips -ness suffix', () => {
    expect(tokenizeAndStem('darkness')).toEqual(['dark'])
  })

  it('does not stem short words', () => {
    expect(tokenizeAndStem('is')).toEqual([])
    expect(tokenizeAndStem('be')).toEqual([])
  })

  it('does not stem CJK tokens', () => {
    expect(tokenizeAndStem('测试')).toEqual(['测试'])
  })
})

describe('computeWeightedTf', () => {
  it('applies max-normalized per-field weights', () => {
    const tf = computeWeightedTf([
      { tokens: ['foo', 'foo', 'bar'], weight: 1.0 },
    ])
    expect(tf.get('foo')).toBeCloseTo(1.0, 5)
    expect(tf.get('bar')).toBeCloseTo(0.5, 5)
  })

  it('uses max merging across fields (not sum)', () => {
    const tf = computeWeightedTf([
      { tokens: ['foo'], weight: 1.0 },
      { tokens: ['foo'], weight: 2.0 },
    ])
    expect(tf.get('foo')).toBeCloseTo(2.0, 5)
  })

  it('returns empty for empty input', () => {
    expect(computeWeightedTf([]).size).toBe(0)
  })
})

describe('computeIdf', () => {
  it('returns log(N/df) per term', () => {
    const idf = computeIdf([
      { tokens: ['a', 'b'] },
      { tokens: ['a', 'c'] },
      { tokens: ['b', 'c'] },
    ])
    expect(idf.get('a')).toBeCloseTo(Math.log(3 / 2), 5)
    expect(idf.get('b')).toBeCloseTo(Math.log(3 / 2), 5)
    expect(idf.get('c')).toBeCloseTo(Math.log(3 / 2), 5)
  })

  it('skips duplicate tokens within a doc', () => {
    const idf = computeIdf([
      { tokens: ['a', 'a', 'a'] },
      { tokens: ['a'] },
    ])
    expect(idf.get('a')).toBeCloseTo(Math.log(2 / 2), 5)
  })

  it('returns empty map for empty index', () => {
    expect(computeIdf([]).size).toBe(0)
  })
})

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = new Map([['a', 0.5], ['b', 0.3]])
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5)
  })

  it('returns 0 for orthogonal vectors', () => {
    const q = new Map([['a', 0.5]])
    const d = new Map([['b', 0.3]])
    expect(cosineSimilarity(q, d)).toBe(0)
  })

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity(new Map(), new Map())).toBe(0)
  })
})

describe('normalizeName', () => {
  it('lowercases and replaces [-_] with space', () => {
    expect(normalizeName('Foo-Bar_Baz')).toBe('foo bar baz')
  })
})

describe('splitHyphenatedName', () => {
  it('splits and filters short parts', () => {
    expect(splitHyphenatedName('foo-bar-baz-qux')).toEqual(['foo', 'bar', 'baz', 'qux'])
  })

  it('drops parts shorter than 3 chars', () => {
    expect(splitHyphenatedName('a-bc-def')).toEqual(['def'])
  })
})

describe('applyCjkFilter', () => {
  it('zeroes score when no CJK match and no ASCII match', () => {
    const entry = { tfVector: new Map([['foo', 1]]) }
    expect(applyCjkFilter(entry, ['测试', '代码'], [], 0.5)).toBe(0)
  })

  it('keeps score when there is at least 1 ASCII match', () => {
    const entry = { tfVector: new Map([['hello', 1]]) }
    expect(applyCjkFilter(entry, ['测试', '代码'], ['hello'], 0.5)).toBe(0.5)
  })

  it('keeps score when enough CJK bigrams match', () => {
    const entry = { tfVector: new Map([['测试', 1], ['试代', 1]]) }
    expect(applyCjkFilter(entry, ['测试', '试代'], [], 0.5)).toBe(0.5)
  })

  it('returns score unchanged when no CJK query tokens', () => {
    const entry = { tfVector: new Map([['foo', 1]]) }
    expect(applyCjkFilter(entry, [], ['hello'], 0.7)).toBe(0.7)
  })
})

describe('buildQueryTfIdf', () => {
  it('returns empty tfIdf for stop-word-only query', () => {
    const result = buildQueryTfIdf('the is', new Map())
    expect(result.tfIdf.size).toBe(0)
  })

  it('multiplies tf by idf', () => {
    const result = buildQueryTfIdf('foo', new Map([['foo', Math.log(5)]]))
    expect(result.tfIdf.get('foo')).toBeCloseTo(Math.log(5), 5)
  })
})

describe('getQueryTokenSeparators', () => {
  it('splits CJK and ASCII tokens', () => {
    const { cjk, ascii } = getQueryTokenSeparators(['hello', '测试', 'world', '代码'])
    expect(cjk).toEqual(['测试', '代码'])
    expect(ascii).toEqual(['hello', 'world'])
  })
})

describe('STOP_WORDS', () => {
  it('contains common English stop words', () => {
    expect(STOP_WORDS.has('the')).toBe(true)
    expect(STOP_WORDS.has('a')).toBe(true)
    expect(STOP_WORDS.has('is')).toBe(true)
    expect(STOP_WORDS.has('foo')).toBe(false)
  })
})
