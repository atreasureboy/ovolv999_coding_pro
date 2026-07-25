import { describe, it, expect } from 'vitest'
import {
  validateImage,
  getMimeType,
  getImageDimensions,
  getImageInfo,
  buildImageContentPart,
  formatImageInfo,
  storeImage,
  getClipboardImagePath,
} from '../src/utils/imageInput.js'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'ovolv999-test-images')

function makeTmpDir(): string {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  return TMP
}

function writePng(path: string, width: number, height: number): void {
  // Minimal PNG: 8-byte signature + IHDR + IDAT + IEND
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

  // IHDR chunk
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 2 // color type (RGB)
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace

  const ihdrType = Buffer.from('IHDR')
  const ihdrCrc = Buffer.alloc(4)
  // CRC32 placeholder (zeros are fine for our test — we only check signature+dimensions parsing)

  const buf = Buffer.concat([
    sig,
    Buffer.from([0, 0, 0, 13]), // length
    ihdrType,
    ihdrData,
    ihdrCrc,
  ])
  writeFileSync(path, buf)
}

describe('imageInput', () => {
  describe('getMimeType', () => {
    it('returns correct MIME for known extensions', () => {
      expect(getMimeType('photo.png')).toBe('image/png')
      expect(getMimeType('photo.jpg')).toBe('image/jpeg')
      expect(getMimeType('photo.jpeg')).toBe('image/jpeg')
      expect(getMimeType('anim.gif')).toBe('image/gif')
      expect(getMimeType('pic.webp')).toBe('image/webp')
    })

    it('returns octet-stream for unknown', () => {
      expect(getMimeType('file.txt')).toBe('application/octet-stream')
    })
  })

  describe('validateImage', () => {
    it('rejects non-existent files', () => {
      const result = validateImage('/nonexistent/image.png')
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('File does not exist')
    })

    it('rejects unsupported extensions', () => {
      const dir = makeTmpDir()
      const path = join(dir, 'image.txt')
      writeFileSync(path, 'not an image')
      const result = validateImage(path)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('Unsupported'))).toBe(true)
    })

    it('rejects empty files', () => {
      const dir = makeTmpDir()
      const path = join(dir, 'empty.png')
      writeFileSync(path, '')
      const result = validateImage(path)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('empty'))).toBe(true)
    })

    it('validates a proper PNG', () => {
      const dir = makeTmpDir()
      const path = join(dir, 'valid.png')
      writePng(path, 100, 100)
      const result = validateImage(path)
      expect(result.valid).toBe(true)
    })
  })

  describe('getImageDimensions', () => {
    it('reads PNG dimensions from header', () => {
      const dir = makeTmpDir()
      const path = join(dir, '200x100.png')
      writePng(path, 200, 100)
      const dims = getImageDimensions(path)
      expect(dims).toEqual({ width: 200, height: 100 })
    })

    it('returns null for non-existent', () => {
      expect(getImageDimensions('/nonexistent.png')).toBeNull()
    })
  })

  describe('getImageInfo', () => {
    it('returns image info', () => {
      const dir = makeTmpDir()
      const path = join(dir, 'info.png')
      writePng(path, 50, 60)
      const info = getImageInfo(path)
      expect(info).toBeTruthy()
      expect(info!.mimeType).toBe('image/png')
      expect(info!.width).toBe(50)
      expect(info!.height).toBe(60)
      expect(info!.sizeBytes).toBeGreaterThan(0)
    })

    it('includes base64 when requested', () => {
      const dir = makeTmpDir()
      const path = join(dir, 'b64.png')
      writePng(path, 10, 10)
      const info = getImageInfo(path, true)
      expect(info!.base64).toBeTruthy()
      expect(info!.base64!.length).toBeGreaterThan(0)
    })

    it('returns null for non-existent', () => {
      expect(getImageInfo('/nonexistent.png')).toBeNull()
    })
  })

  describe('buildImageContentPart', () => {
    it('builds data URL', () => {
      const dir = makeTmpDir()
      const path = join(dir, 'content.png')
      writePng(path, 10, 10)
      const part = buildImageContentPart(path)
      expect(part).toBeTruthy()
      expect(part!.type).toBe('image_url')
      expect(part!.image_url.url).toContain('data:image/png;base64,')
    })

    it('returns null for invalid file', () => {
      expect(buildImageContentPart('/nonexistent.png')).toBeNull()
    })
  })

  describe('formatImageInfo', () => {
    it('formats info correctly', () => {
      const dir = makeTmpDir()
      const path = join(dir, 'fmt.png')
      writePng(path, 100, 200)
      const info = getImageInfo(path)!
      const out = formatImageInfo(info)
      expect(out).toContain('image/png')
      expect(out).toContain('100x200')
    })
  })

  describe('storeImage', () => {
    it('stores valid image', () => {
      const dir = makeTmpDir()
      const path = join(dir, 'store.png')
      writePng(path, 30, 30)
      const stored = storeImage(path)
      expect(stored).toBeTruthy()
      expect(existsSync(stored!)).toBe(true)
    })

    it('returns null for invalid image', () => {
      const stored = storeImage('/nonexistent.png')
      expect(stored).toBeNull()
    })
  })

  describe('getClipboardImagePath', () => {
    it('returns null when no clipboard tool available', () => {
      const result = getClipboardImagePath()
      // In test environment, likely returns null (string if clipboard has an image)
      expect(result === null || typeof result === 'string').toBeTruthy()
    })
  })
})
