import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadPeriodView, loadPeriodHistory } from '@/lib/recon/monthly/query'
import { buildPeriodWorkbook } from '@/lib/export/recon-period-workbook'
import { monthOf, type ReconStatus } from '@/lib/recon/monthly/period'
import { slugify } from '@/lib/export/report'

/**
 * EXPORT ONE MONTH'S RECONCILIATION. Authenticates on its first line — 401,
 * not a redirect — as every export route does. An approved month is written
 * from its frozen snapshot, exactly as its page shows it.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const text = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) return text('UNAUTHORISED', 401)
  const id = new URL(request.url).searchParams.get('id') ?? ''
  const view = await loadPeriodView(prisma, id)
  if (!view) return text('NOT FOUND', 404)
  const history = await loadPeriodHistory(prisma, id)
  const approver = view.period.approvedById ? await prisma.user.findUnique({ where: { id: view.period.approvedById }, select: { name: true } }) : null
  const month = monthOf(view.period.periodStart)
  const workbook = await buildPeriodWorkbook(view.computation, {
    accountCode: view.account.code, bankCode: view.account.bankCode, month, currency: view.period.currency,
    status: view.period.status as ReconStatus, frozen: view.frozen, generatedAt: new Date(), generatedBy: user.name,
    approvedBy: approver?.name ?? null,
    history: history.map((h) => ({ at: h.createdAt, action: h.action, by: h.user?.name ?? 'SYSTEM', remarks: h.remarks })),
  })
  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${slugify(`bank reconciliation ${view.account.code} ${month}`)}.xlsx"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
