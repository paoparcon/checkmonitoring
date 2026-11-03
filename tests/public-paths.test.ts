import { describe, it, expect } from 'vitest'
import { isPublicPath } from '@/lib/public-paths'

/**
 * Pure. The middleware DOES run on Vercel (measured 2026-09-11: production
 * redirected `/api/cron/sync` to `/login` with NextAuth cookies set), so what
 * it waves through is a real production control and is pinned here.
 */
describe('isPublicPath', () => {
  it('lets the login page and the auth callbacks through', () => {
    expect(isPublicPath('/login')).toBe(true)
    expect(isPublicPath('/api/auth/callback/credentials')).toBe(true)
    expect(isPublicPath('/api/auth/session')).toBe(true)
  })

  /**
   * The scheduled sync carries a bearer, never a session. Redirecting it to
   * /login would make every evening's run a login page, reported as success.
   */
  it('lets the scheduled sync through to its own bearer check', () => {
    expect(isPublicPath('/api/cron/sync')).toBe(true)
  })

  it('lets the landing page through', () => {
    expect(isPublicPath('/welcome')).toBe(true)
  })

  it('lets the sign-up page through, and only exactly it', () => {
    expect(isPublicPath('/signup')).toBe(true)
    expect(isPublicPath('/signupx')).toBe(false)
    expect(isPublicPath('/signup/')).toBe(false)
    expect(isPublicPath('/signup/anything')).toBe(false)
  })

  it('does not widen /login or /welcome to their neighbours', () => {
    expect(isPublicPath('/loginhelp')).toBe(false)
    expect(isPublicPath('/login/')).toBe(false)
    expect(isPublicPath('/welcomeback')).toBe(false)
    expect(isPublicPath('/welcome/')).toBe(false)
  })

  it('keeps every page and every other API route behind a session', () => {
    for (const p of ['/', '/vouchers', '/checks/abc', '/admin/sync', '/api/export', '/api/export/vouchers', '/print']) {
      expect(isPublicPath(p), p).toBe(false)
    }
  })
})
