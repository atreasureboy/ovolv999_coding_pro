/**
 * LSP protocol — minimal subset of LSP (Language Server Protocol)
 * types we need to drive `definition` / `references` / `hover` /
 * `documentSymbol` from the LLM.
 *
 * We deliberately implement the minimum surface area — full LSP has
 * 100+ methods. We only need 5 messages plus the JSON-RPC 2.0
 * envelope.
 */

export interface LspPosition {
  line: number      // 0-indexed
  character: number  // 0-indexed UTF-16 code unit
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspSymbolInformation {
  name: string
  kind: number  // SymbolKind enum, see below
  location: LspLocation
  containerName?: string
}

export interface LspHover {
  contents: string | { kind: 'markdown' | 'plaintext'; value: string } | Array<string | { language: string; value: string }>
  range?: LspRange
}

export interface LspResponse<T> {
  jsonrpc: '2.0'
  id: number | string
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

export interface LspNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface LspRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export const LSP_SYMBOL_KIND = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const

export const LSP_SYMBOL_KIND_NAMES: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
  6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
  11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String',
  16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
  21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
}
