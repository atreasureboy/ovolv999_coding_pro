/**
 * Image Input Utilities
 *
 * Handles pasted/clipboard/drag-dropped images for vision-capable models.
 * Provides validation, resizing, base64 encoding, and storage.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, extname } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export interface ImageInfo {
  path: string
  mimeType: string
  width?: number
  height?: number
  sizeBytes: number
  base64?: string
}

export interface ImageValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

// ── Constants ───────────────────────────────────────────────────────────────

const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
])

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20 MB
const MAX_DIMENSION = 4096
const MIN_DIMENSION = 16

// ── Validation ──────────────────────────────────────────────────────────────

export function validateImage(path: string): ImageValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!existsSync(path)) {
    return { valid: false, errors: ['File does not exist'], warnings }
  }

  const ext = extname(path).toLowerCase()
  const mimeType = EXT_TO_MIME[ext]
  if (!mimeType) {
    errors.push(`Unsupported file extension: ${ext}. Supported: ${Object.keys(EXT_TO_MIME).join(', ')}`)
    return { valid: false, errors, warnings }
  }

  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    errors.push(`Unsupported MIME type: ${mimeType}`)
  }

  const stat = statSync(path)
  if (stat.size > MAX_IMAGE_SIZE) {
    errors.push(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`)
  }

  if (stat.size === 0) {
    errors.push('Image file is empty')
  }

  // Check dimensions if possible
  const dims = getImageDimensions(path)
  if (dims) {
    if (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION) {
      warnings.push(`Large dimensions ${dims.width}x${dims.height} (max recommended: ${MAX_DIMENSION}x${MAX_DIMENSION})`)
    }
    if (dims.width < MIN_DIMENSION || dims.height < MIN_DIMENSION) {
      warnings.push(`Small dimensions ${dims.width}x${dims.height} (min recommended: ${MIN_DIMENSION}x${MIN_DIMENSION})`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

export function getMimeType(path: string): string {
  const ext = extname(path).toLowerCase()
  return EXT_TO_MIME[ext] ?? 'application/octet-stream'
}

// ── Dimensions ──────────────────────────────────────────────────────────────

export function getImageDimensions(path: string): { width: number; height: number } | null {
  try {
    // Try file command (Linux/macOS)
    const output = execSync(`file "${path}"`, { encoding: 'utf8', timeout: 5000 })

    // Parse output like: "image.png: PNG image data, 1920 x 1080, 8-bit/color/RGBA, non-interlaced"
    const m = output.match(/(\d+)\s*[x×]\s*(\d+)/)
    if (m) {
      return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) }
    }
  } catch { /* file not available */ }

  // Try parsing PNG header directly
  try {
    const buf = readFileSync(path)
    if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      const width = buf.readUInt32BE(16)
      const height = buf.readUInt32BE(20)
      return { width, height }
    }
  } catch { /* not a PNG or unreadable */ }

  return null
}

// ── Base64 Encoding ─────────────────────────────────────────────────────────

export function encodeImageBase64(path: string): string {
  const buf = readFileSync(path)
  return buf.toString('base64')
}

export function getImageInfo(path: string, includeBase64 = false): ImageInfo | null {
  if (!existsSync(path)) return null

  const stat = statSync(path)
  const dims = getImageDimensions(path)
  const info: ImageInfo = {
    path,
    mimeType: getMimeType(path),
    sizeBytes: stat.size,
  }

  if (dims) {
    info.width = dims.width
    info.height = dims.height
  }

  if (includeBase64) {
    info.base64 = encodeImageBase64(path)
  }

  return info
}

// ── Image Storage ───────────────────────────────────────────────────────────

export function getImageStoreDir(): string {
  return join(homedir(), '.ovolv999', 'images')
}

export function storeImage(sourcePath: string, sessionId?: string): string | null {
  const validation = validateImage(sourcePath)
  if (!validation.valid) return null

  const dir = getImageStoreDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const ext = extname(sourcePath).toLowerCase()
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  const filename = sessionId
    ? `${sessionId}-${timestamp}-${random}${ext}`
    : `${timestamp}-${random}${ext}`
  const destPath = join(dir, filename)

  const srcBuf = readFileSync(sourcePath)
  writeFileSync(destPath, srcBuf)

  return destPath
}

// ── Resizing ────────────────────────────────────────────────────────────────

export function needsResize(path: string, maxDimension = MAX_DIMENSION): boolean {
  const dims = getImageDimensions(path)
  if (!dims) return false
  return dims.width > maxDimension || dims.height > maxDimension
}

export function getResizedPath(path: string, maxDimension = MAX_DIMENSION): string {
  const dims = getImageDimensions(path)
  if (!dims || !needsResize(path, maxDimension)) return path

  // Try to use sips (macOS) or convert (ImageMagick)
  try {
    const ext = extname(path)
    const resizedPath = path.replace(ext, `_resized${ext}`)

    // Try ImageMagick
    try {
      execSync(`convert "${path}" -resize ${maxDimension}x${maxDimension}\\> "${resizedPath}"`, {
        timeout: 10000,
        stdio: 'pipe',
      })
      if (existsSync(resizedPath)) return resizedPath
    } catch { /* ImageMagick not available */ }

    // Try sips (macOS)
    try {
      execSync(`sips --resampleHeightWidthMax ${maxDimension} "${path}" --out "${resizedPath}"`, {
        timeout: 10000,
        stdio: 'pipe',
      })
      if (existsSync(resizedPath)) return resizedPath
    } catch { /* sips not available */ }
  } catch { /* resize failed */ }

  return path
}

// ── Content Part Builder ────────────────────────────────────────────────────

export interface ImageContentPart {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
}

export function buildImageContentPart(
  path: string,
  detail: 'auto' | 'low' | 'high' = 'auto',
): ImageContentPart | null {
  const info = getImageInfo(path, true)
  if (!info || !info.base64) return null

  const mimeType = info.mimeType
  return {
    type: 'image_url',
    image_url: {
      url: `data:${mimeType};base64,${info.base64}`,
      detail,
    },
  }
}

// ── Clipboard Image Detection ───────────────────────────────────────────────

export function getClipboardImagePath(): string | null {
  // macOS: pngpaste required
  // Linux: xclip required
  const dir = getImageStoreDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tmpPath = join(dir, `clipboard-${Date.now()}.png`)

  // Try macOS pngpaste
  try {
    execSync(`pngpaste "${tmpPath}"`, { timeout: 5000, stdio: 'pipe' })
    if (existsSync(tmpPath) && statSync(tmpPath).size > 0) return tmpPath
  } catch { /* not macOS or pngpaste not installed */ }

  // Try Linux xclip
  try {
    execSync(`xclip -selection clipboard -t image/png -o > "${tmpPath}"`, {
      timeout: 5000,
      stdio: 'pipe',
      shell: '/bin/bash',
    })
    if (existsSync(tmpPath) && statSync(tmpPath).size > 0) return tmpPath
  } catch { /* not Linux or xclip not installed */ }

  return null
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatImageInfo(info: ImageInfo): string {
  const parts = [
    `Image: ${info.path}`,
    `  Type: ${info.mimeType}`,
    `  Size: ${(info.sizeBytes / 1024).toFixed(1)}KB`,
  ]
  if (info.width && info.height) {
    parts.push(`  Dimensions: ${info.width}x${info.height}`)
  }
  if (info.base64) {
    parts.push(`  Base64 length: ${info.base64.length}`)
  }
  return parts.join('\n')
}
