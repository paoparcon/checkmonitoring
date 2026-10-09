import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadTransmittalCandidates } from '@/lib/transmittal-query'

/**
 * The RELEASED checks for the transmittal picker, loaded when the RELEASED
 * option is chosen (~10,000 rows, too many to ship with every page load).
 * Authenticates on its first line — 401, not a redirect — like every data
 * route; read-only.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
  }
  return Response.json(await loadTransmittalCandidates(prisma, ['RELEASED']), { headers: { 'cache-control': 'no-store' } })
}
