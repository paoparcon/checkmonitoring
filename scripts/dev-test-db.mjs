/**
 * Start the dev server against the TEST database.
 *
 *   node scripts/dev-test-db.mjs [--port 3100]
 *
 * WHY THIS EXISTS. The repo's `.env` names PRODUCTION in `DATABASE_URL` —
 * `npm run dev` on a laptop reads and writes real checks. A browser check of a
 * new screen therefore had no safe target until this script: it loads `.env`
 * itself, swaps the `*_TEST` connection strings in for the plain ones (the same
 * substitution `scripts/migrate.mjs test` makes), blanks every outward
 * integration so nothing can reach Acumatica or the Supplier Portal from a
 * test session, and spawns `next dev` with that environment and NO shell — the
 * Neon URL carries `&` and `?`, which a shell would interpret.
 *
 * The test database is the one the Vitest suite truncates. Anything typed into
 * this server is gone on the next test run, which is the point.
 *
 * Prints the host and database it points at, never the credentials.
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const port = portIdx >= 0 ? args[portIdx + 1] : '3100'

const SWAP = { DATABASE_URL: 'DATABASE_URL_TEST', DIRECT_DATABASE_URL: 'DIRECT_DATABASE_URL_TEST' }
const BLANK = [
  'ACUMATICA_ODATA_URL', 'ACUMATICA_ODATA_USER', 'ACUMATICA_ODATA_PASSWORD', 'ACUMATICA_ODATA_URL_MFG',
  'PORTAL_BASE_URL', 'PORTAL_TOKEN', 'CRON_SECRET',
]

const env = { ...process.env }
for (const [name, from] of Object.entries(SWAP)) {
  const value = process.env[from]
  if (!value) {
    console.error(`${from} is not set in .env; refusing to start against anything else.`)
    process.exit(2)
  }
  env[name] = value
}
if (env.DATABASE_URL === process.env.DATABASE_URL) {
  console.error('DATABASE_URL_TEST equals DATABASE_URL; refusing.')
  process.exit(2)
}
for (const name of BLANK) delete env[name]

const where = new URL(env.DATABASE_URL)
console.log(`Dev server on TEST database: ${where.hostname}${where.pathname} (port ${port})`)

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(
  process.execPath,
  [path.join(repo, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', port],
  { cwd: repo, env, stdio: 'inherit', shell: false },
)
child.on('exit', (code) => process.exit(code ?? 1))
