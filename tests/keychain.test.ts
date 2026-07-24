import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { encrypt, decrypt, setSecret, getSecret, deleteSecret, listSecrets, getVaultMetadata, detectBackend } from '../src/utils/keychain.js'
import { rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'

const PASSPHRASE = 'test-passphrase-123'
let origHome: string | undefined
let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ovolv999-vault-'))
  origHome = process.env.HOME
  process.env.HOME = testDir
  process.env.OVOLV999_VAULT_PASSPHRASE = PASSPHRASE
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  delete process.env.OVOLV999_VAULT_PASSPHRASE
  rmSync(testDir, { recursive: true, force: true })
})

describe('keychain', () => {
  describe('encryption', () => {
    it('encrypts and decrypts text', () => {
      const original = 'my secret value 123'
      const encrypted = encrypt(original, PASSPHRASE)
      expect(encrypted).not.toBe(original)
      const decrypted = decrypt(encrypted, PASSPHRASE)
      expect(decrypted).toBe(original)
    })

    it('produces different ciphertext for same input (random IV)', () => {
      const text = 'same value'
      const enc1 = encrypt(text, PASSPHRASE)
      const enc2 = encrypt(text, PASSPHRASE)
      expect(enc1).not.toBe(enc2)
    })

    it('fails with wrong passphrase', () => {
      const encrypted = encrypt('secret', PASSPHRASE)
      expect(() => decrypt(encrypted, 'wrong-pass')).toThrow()
    })
  })

  describe('detectBackend', () => {
    it('returns a valid backend name', () => {
      const backend = detectBackend()
      expect(['keychain-macos', 'libsecret', 'credential-manager', 'file']).toContain(backend)
    })
  })

  describe('vault operations (file backend)', () => {
    // These tests only run if backend is 'file'
    const isFileBackend = detectBackend() === 'file'
    const describeOrSkip = isFileBackend ? describe : describe.skip

    describeOrSkip('file backend', () => {
      it('stores and retrieves a secret', () => {
        setSecret('test-key', 'test-value', PASSPHRASE)
        const value = getSecret('test-key', PASSPHRASE)
        expect(value).toBe('test-value')
      })

      it('updates existing secret', () => {
        setSecret('update-key', 'old-value', PASSPHRASE)
        setSecret('update-key', 'new-value', PASSPHRASE)
        const value = getSecret('update-key', PASSPHRASE)
        expect(value).toBe('new-value')
      })

      it('returns null for non-existent key', () => {
        expect(getSecret('nonexistent', PASSPHRASE)).toBeNull()
      })

      it('deletes secrets', () => {
        setSecret('delete-me', 'value', PASSPHRASE)
        expect(deleteSecret('delete-me', PASSPHRASE)).toBe(true)
        expect(getSecret('delete-me', PASSPHRASE)).toBeNull()
      })

      it('returns false when deleting non-existent', () => {
        expect(deleteSecret('nonexistent', PASSPHRASE)).toBe(false)
      })

      it('lists secret keys', () => {
        setSecret('list-1', 'val1', PASSPHRASE)
        setSecret('list-2', 'val2', PASSPHRASE)
        const keys = listSecrets(PASSPHRASE)
        expect(keys).toContain('list-1')
        expect(keys).toContain('list-2')
      })

      it('reports metadata', () => {
        const metadata = getVaultMetadata(PASSPHRASE)
        expect(metadata.backend).toBe('file')
        expect(metadata.count).toBeGreaterThan(0)
      })
    })
  })

  describe('error handling', () => {
    it('throws without passphrase on file backend', () => {
      const backend = detectBackend()
      if (backend === 'file') {
        expect(() => setSecret('key', 'val')).toThrow('Passphrase required')
      }
    })
  })
})
