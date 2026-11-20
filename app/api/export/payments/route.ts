import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { listOtherPayments } from '@/lib/payments/query'
import { buildPaymentsWorkbook, paymentsFilename } from '@/lib/export/payments-workbook'

/**
 * EXPORT OTHER PAYMENTS: every payment held, with its marking (2026-11-20).
 * Authenticates on its first line and answers 401, not a redirect - a
 * download that redirects arrives as a login page saved under an .xlsx name.
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
  const rows = await listOtherPayments(prisma)
  const workbook = await buildPaymentsWorkbook({ rows, generatedAt: now, generatedBy: user.name })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${paymentsFilename(now)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
