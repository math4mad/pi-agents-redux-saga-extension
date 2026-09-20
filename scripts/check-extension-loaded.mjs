// Ask a throwaway `pi --mode rpc` process which slash commands it registers,
// and report whether the project-local extensions made the cut.
// Costs no model tokens: get_commands is answered locally.
//
// Run: node scripts/check-extension-loaded.mjs [--approve] [--expect name]
import { spawn } from 'node:child_process'

const extraArgs = process.argv.includes('--approve') ? ['-a'] : []
const EXPECTED = ['dashboard', 'desk-status']

const probe = () => new Promise((resolve) => {
  const child = spawn('pi', ['--mode', 'rpc', '--no-session', ...extraArgs], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let deskReport = ''
  const done = (value) => { clearTimeout(timer); child.kill('SIGKILL'); resolve(value) }
  const timer = setTimeout(() => done({ error: 'timed out after 45s (is pi installed and on PATH?)' }), 45000)

  // The agent-desk extension prints one line about which tools it registered.
  child.stderr.on('data', (chunk) => {
    const match = chunk.toString().match(/agent-desk: .*/)
    if (match) deskReport = match[0].trim()
  })
  child.on('error', (error) => done({ error: error.message }))
  child.stdin.write(`${JSON.stringify({ id: 'probe-1', type: 'get_commands' })}\n`)
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    for (const line of buffer.split('\n').filter(Boolean)) {
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.type === 'response' && message.command === 'get_commands') {
        done({
          commands: (message.data?.commands ?? message.data ?? []).map((c) => c.name ?? c),
          deskReport,
        })
      }
    }
  })
})

const { commands, deskReport, error } = await probe()
if (error) {
  console.log(`FAIL  could not probe pi: ${error}`)
  process.exitCode = 1
} else {
  console.log(`probed ${commands.length} commands (args: ${extraArgs.join(' ') || 'none'})`)
  if (deskReport) console.log(`      ${deskReport}`)
  for (const name of EXPECTED) {
    const loaded = commands.includes(name)
    console.log(`${loaded ? 'PASS' : 'FAIL'}  /${name} ${loaded ? 'registered' : 'NOT registered'}`)
    if (!loaded) process.exitCode = 1
  }
  if (process.exitCode) {
    console.log('      .pi/extensions is trust-gated. Start pi with `pi -a` once, or answer the')
    console.log('      interactive trust prompt with yes, to save a decision in ~/.pi/agent/trust.json.')
    console.log('      The bridge needs it too: run it as BRIDGE_TRUST=1 npm run agent-server.')
  }
}
