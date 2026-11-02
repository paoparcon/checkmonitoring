/**
 * The dev server against the TEST database.
 *
 *   node --env-file=.env scripts/dev-testdb.mjs      # http://localhost:3001
 *
 * WHY THIS EXISTS. `npm run dev` connects to whatever DATABASE_URL names, and
 * in .env that is PRODUCTION. A page that reads a table whose migration has
 * not reached production yet 500s there, and a click on a form writes real
 * rows. This swaps the *_TEST URLs in — the same substitution
 * `scripts/migrate.mjs test` makes — and starts `next dev` on port 3001, so a
 * screen can be tried against the test database (seed it first; the suite
 * truncates it). The shell cannot source .env: the Neon URL carries `&`, so
 * Node's own --env-file loads it. Next's env loader does not override a
 * variable already set, so the swap holds. `.claude/launch.json` names it.
 */
import { spawn } from 'node:child_process'

const test = process.env.DATABASE_URL_TEST
if (!test || test === process.env.DATABASE_URL) {
  console.error('DATABASE_URL_TEST is unset or equal to DATABASE_URL; refusing to start.')
  process.exit(2)
}
const env = { ...process.env, DATABASE_URL: test, DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL_TEST ?? test }
console.log(`dev server on :3001 against the TEST database (${new URL(test).hostname})`)
const child = spawn('npx', ['next', 'dev', '-p', '3001'], { env, stdio: 'inherit', cwd: process.cwd() })
child.on('exit', (code) => process.exit(code ?? 1))
