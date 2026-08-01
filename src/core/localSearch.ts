/**
 * TF-IDF based local search core. Single algorithm module serves both
 * tool search and skill search; consumers (toolSearch.ts, skillSearch.ts)
 * build their indices and call search.
 */

export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'this', 'that',
  'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
  'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'use', 'using',
])

const CJK_RANGE = /[一-鿿㐀-䶿]/

function isCjk(ch: string | undefined): boolean {
  return !!ch && CJK_RANGE.test(ch)
}

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  let i = 0

  while (i < lower.length) {
    const ch = lower[i]
    if (isCjk(ch)) {
      let cjkRun = ''
      while (i < lower.length && isCjk(lower[i])) {
        cjkRun += lower[i]
        i++
      }
      for (let j = 0; j < cjkRun.length - 1; j++) {
        tokens.push(cjkRun.slice(j, j + 2))
      }
    } else if (/[a-z0-9]/.test(ch)) {
      let word = ''
      while (i < lower.length && /[a-z0-9\-_]/.test(lower[i])) {
        word += lower[i]
        i++
      }
      const cleaned = word.replace(/^[-_]+|[-_]+$/g, '')
      if (cleaned && !STOP_WORDS.has(cleaned)) {
        tokens.push(cleaned)
      }
    } else {
      i++
    }
  }

  return tokens
}

function stem(word: string): string {
  if (isCjk(word[0])) return word
  let s = word
  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3)
  else if (s.endsWith('tion') && s.length > 5) s = s.slice(0, -4)
  else if (s.endsWith('ness') && s.length > 5) s = s.slice(0, -4)
  else if (s.endsWith('ment') && s.length > 5) s = s.slice(0, -4)
  else if (s.endsWith('ers') && s.length > 4) s = s.slice(0, -1)
  else if (s.endsWith('er') && s.length > 4) s = s.slice(0, -2)
  else if (s.endsWith('es') && s.length > 4) s = s.slice(0, -2)
  else if (s.endsWith('s') && s.length > 3 && !s.endsWith('ss'))
    s = s.slice(0, -1)
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2)
  else if (s.endsWith('ly') && s.length > 4) s = s.slice(0, -2)
  return s
}

export function tokenizeAndStem(text: string): string[] {
  return tokenize(text).map(stem)
}

export interface WeightedTfField {
  tokens: string[]
  weight: number
}

export function computeWeightedTf(fields: WeightedTfField[]): Map<string, number> {
  const weighted = new Map<string, number>()
  for (const field of fields) {
    const freq = new Map<string, number>()
    for (const t of field.tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
    let max = 1
    for (const v of freq.values()) if (v > max) max = v
    for (const [term, count] of freq) {
      const val = (count / max) * field.weight
      const existing = weighted.get(term) ?? 0
      if (val > existing) weighted.set(term, val)
    }
  }
  return weighted
}

export function computeIdf(index: { tokens: string[] }[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const entry of index) {
    const seen = new Set<string>()
    for (const t of entry.tokens) {
      if (!seen.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1)
        seen.add(t)
      }
    }
  }
  const N = index.length
  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log(N / count))
  }
  return idf
}

export function cosineSimilarity(
  queryTfIdf: Map<string, number>,
  docTfIdf: Map<string, number>,
): number {
  let dot = 0
  let normQ = 0
  let normD = 0

  for (const [term, qWeight] of queryTfIdf) {
    const dWeight = docTfIdf.get(term) ?? 0
    dot += qWeight * dWeight
    normQ += qWeight * qWeight
  }
  for (const dWeight of docTfIdf.values()) {
    normD += dWeight * dWeight
  }

  const denom = Math.sqrt(normQ) * Math.sqrt(normD)
  return denom === 0 ? 0 : dot / denom
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, ' ')
}

export function splitHyphenatedName(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_]/)
    .filter(p => p.length >= 3)
}

export const CJK_MIN_BIGRAM_MATCHES = 2

export function getQueryTokenSeparators(queryTokens: string[]): {
  cjk: string[]
  ascii: string[]
} {
  return {
    cjk: queryTokens.filter(t => isCjk(t[0])),
    ascii: queryTokens.filter(t => !isCjk(t[0])),
  }
}

export function applyCjkFilter(
  entry: { tfVector: Map<string, number> },
  queryCjk: string[],
  queryAscii: string[],
  score: number,
): number {
  if (queryCjk.length > 0 && score > 0) {
    const matchingCjk = queryCjk.filter(t => entry.tfVector.has(t))
    if (matchingCjk.length < CJK_MIN_BIGRAM_MATCHES) {
      const hasAsciiMatch = queryAscii.some(t => entry.tfVector.has(t))
      if (!hasAsciiMatch) return 0
    }
  }
  return score
}

export function buildQueryTfIdf(
  query: string,
  idf: Map<string, number>,
): { tfIdf: Map<string, number>; tokens: string[] } {
  const tokens = tokenizeAndStem(query)
  if (tokens.length === 0) return { tfIdf: new Map(), tokens }

  const freq = new Map<string, number>()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  let max = 1
  for (const v of freq.values()) if (v > max) max = v

  const tf = new Map<string, number>()
  for (const [term, count] of freq) tf.set(term, count / max)

  const tfIdf = new Map<string, number>()
  for (const [term, t] of tf) {
    tfIdf.set(term, t * (idf.get(term) ?? 0))
  }
  return { tfIdf, tokens }
}
