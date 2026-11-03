import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadAgingRows } from '@/lib/aging/query'
import { buildAgingWorkbook, agingFilename } from '@/lib/export/aging-workbook'

/**
 * EXPORT AGING: every SIGNED check, aged (spec 2026-10-15). Authenticates on
 * its first line and answers 401, not a redirect — `middleware.ts` runs on
 * Vercel and not locally, and a download that redirects arrives as a login
 * page saved under an .xlsx name.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(_request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const now = new Date()
  const { rows, truncated } = await loadAgingRows(prisma, now)
  const workbook = await buildAgingWorkbook({ rows, generatedAt: now, generatedBy: user.name, truncated })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${agingFilename(now)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
