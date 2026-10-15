/**
 * Operator tool: issue a password-reset link for an account when e-mail
 * sending is not configured. Requires direct access to the database, i.e. the
 * same trust level as the person running the server.
 *
 *   npm run auth:reset-link -- someone@example.com https://your-app.example.com
 */
import { createPasswordReset } from '../src/lib/auth/service'
import { closeDb } from '../src/lib/db'

async function main() {
  const [email, origin = process.env.APP_URL ?? 'http://localhost:3000'] = process.argv.slice(2)
  if (!email) {
    console.error('usage: npm run auth:reset-link -- <email> [app-url]')
    process.exit(2)
  }
  const reset = await createPasswordReset(email, 'operator-cli')
  if (!reset) {
    console.error(`No account found for ${email}`)
    process.exitCode = 1
  } else {
    console.log(`Reset link for ${reset.email} (valid 60 minutes, single use):\n${origin.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(reset.token)}`)
  }
  await closeDb()
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e)
  await closeDb().catch(() => {})
  process.exit(1)
})
