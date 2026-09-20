// Environment preflight for running the Pi Agent Control Room on a new machine.
// Run: node scripts/preflight.mjs   (or: npm run preflight)
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const lines = []
const pass = (name, detail = '') => lines.push({ ok: true, name, detail })
const warn = (name, detail = '') => lines.push({ ok: null, name, detail })
const fail = (name, detail = '') => lines.push({ ok: false, name, detail })

const PORTS = { bridge: 8787, vite: 5173 }
const projectDir = process.cwd()

// ---------------------------------------------------------------- platform
if (process.platform === 'darwin') pass('macOS host', process.platform)
else warn('not macOS', `${process.platform} — the dashboard command only shells out to open/xdg-open`)

// ------------------------------------------------------------------ node
const [major, minor] = process.versions.node.split('.').map(Number)
const nodeNum = major * 100 + minor
if (nodeNum >= 2219) pass('Node version', process.version)
else if (nodeNum >= 2218) warn('Node version', `${process.version} — below pi's engines requirement (>=22.19.0)`)
else fail('Node version', `${process.version} — need >=22.19.0 for pi, and >=22.18 so \`npm test\` can import src/*.ts directly`)

// -------------------------------------------------------------------- pi
const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf8' })
if (piVersion.error) {
  fail('pi CLI', 'not on PATH — npm i -g @earendil-works/pi-coding-agent, and make sure the shell running `npm run agent-server` inherits the same PATH (nvm users: `nvm use` first)')
} else {
  pass('pi CLI', `${(piVersion.stdout || '').trim()} at ${spawnSync('which', ['pi'], { encoding: 'utf8' }).stdout.trim()}`)
}

const authFile = path.join(os.homedir(), '.pi', 'agent', 'auth.json')
const envKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY'].filter((k) => process.env[k])
if (fs.existsSync(authFile) && fs.statSync(authFile).size > 2) pass('pi credentials', authFile)
else if (envKeys.length) pass('pi credentials', `env: ${envKeys.join(', ')}`)
else fail('pi credentials', 'no ~/.pi/agent/auth.json and no provider API key env var — the bridge spawns a real agent, so it must be signed in (run `pi` then /login)')

// ----------------------------------------------------------- project trust
const trustFile = path.join(os.homedir(), '.pi', 'agent', 'trust.json')
let trust = {}
try { trust = JSON.parse(fs.readFileSync(trustFile, 'utf8')) } catch { /* no file yet */ }
let dir = projectDir
let decision
while (true) {
  if (dir in trust) { decision = { dir, value: trust[dir] }; break }
  const parent = path.dirname(dir)
  if (parent === dir) break
  dir = parent
}
const settings = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'settings.json'), 'utf8')) } catch { return {} } })()
const defaultTrust = settings.defaultProjectTrust ?? 'ask'

if (!fs.existsSync(path.join(projectDir, '.pi/extensions/dashboard.ts'))) {
  fail('.pi/extensions/dashboard.ts', 'missing — run this from the project root')
} else if (decision?.value === true) {
  pass('project trust', `saved decision for ${decision.dir}`)
} else if (decision?.value === false) {
  fail('project trust', `this directory tree is explicitly untrusted (${decision.dir}) — /dashboard will not load; delete the entry or run \`pi -a\``)
} else if (defaultTrust === 'always') {
  warn('project trust', `no saved decision, but defaultProjectTrust="always" loads it`)
} else {
  fail('project trust', `no saved decision for ${projectDir} and defaultProjectTrust="${defaultTrust}" — pi ignores .pi/extensions in --mode rpc. Run \`pi -a\` here once, or answer "yes" to the trust prompt`)
}

// ----------------------------------------------------------------- install
if (fs.existsSync(path.join(projectDir, 'node_modules/react-redux'))) pass('dependencies', 'node_modules present')
else fail('dependencies', 'run `npm ci` (package-lock.json is committed; node_modules is not)')

// --------------------------------------------------------------- port probe
const listenProbe = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const socket = net.connect({ host, port })
  const finish = (open) => { socket.destroy(); resolve(open) }
  socket.setTimeout(1200, () => finish(false))
  socket.on('connect', () => finish(true))
  socket.on('error', () => finish(false))
  socket.on('timeout', () => finish(false))
})

const bridgeUp = await listenProbe(PORTS.bridge)
const viteUp = await listenProbe(PORTS.vite)
if (bridgeUp) pass(`port ${PORTS.bridge}`, 'Pi RPC bridge is listening')
else warn(`port ${PORTS.bridge}`, 'free — start it with `npm run agent-server`')
if (viteUp) pass(`port ${PORTS.vite}`, 'Vite dev server is listening')
else warn(`port ${PORTS.vite}`, 'free — start it with `npm run dev`')

// ---------------------------------------------------------- bridge contract
if (bridgeUp) {
  // An empty message is rejected before startPi(), so this validates the bridge
  // without spawning a nested agent.
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.bridge}/api/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    })
    const body = await res.json()
    if (res.status === 400 && body.accepted === false) pass('bridge /api/prompt', `rejects empty prompts as expected (${JSON.stringify(body.error)})`)
    else fail('bridge /api/prompt', `unexpected ${res.status} ${JSON.stringify(body)} — something else is on :${PORTS.bridge}?`)
  } catch (error) {
    fail('bridge /api/prompt', error.message)
  }
  try {
    // The desk tools talk to these, so a bridge from before the squad work is
    // not usable even though /api/prompt still answers.
    const status = await (await fetch(`http://127.0.0.1:${PORTS.bridge}/api/status`)).json().catch(() => null)
    if (status?.desk) pass('bridge squad endpoints', `desk=${status.desk} squad=${status.squad}`)
    else fail('bridge version', 'no /api/status - this bridge predates the squad work; restart it: `lsof -ti:8787 | xargs kill` then `BRIDGE_TRUST=1 npm run agent-server`')
    for (const endpoint of ['/api/ask', '/api/dispatch', '/api/approve', '/api/decline']) {
      const res = await fetch(`http://127.0.0.1:${PORTS.bridge}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (res.status !== 400) { fail(`bridge ${endpoint}`, `expected 400 for an empty payload, got ${res.status}`); break }
      pass(`bridge ${endpoint}`, 'validates empty payloads without spawning an agent')
    }
  } catch (error) {
    fail('bridge squad endpoints', error.message)
  }
  try {
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${PORTS.bridge}/api/events`, { signal: controller.signal })
    const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    controller.abort()
    if (isStream) pass('bridge /api/events', 'SSE content-type OK')
    else fail('bridge /api/events', `content-type: ${res.headers.get('content-type')}`)
  } catch (error) {
    fail('bridge /api/events', error.message)
  }
}

if (viteUp) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.vite}/`)
    const html = await res.text()
    if (res.ok && html.includes('src/main.tsx')) pass('vite dev server', 'serves index.html')
    else fail('vite dev server', `status ${res.status}`)
    const proxied = await fetch(`http://127.0.0.1:${PORTS.vite}/api/events`).catch(() => null)
    if (proxied && (proxied.headers.get('content-type') ?? '').includes('text/event-stream')) pass('vite /api proxy', 'forwards to the bridge on :' + PORTS.bridge)
    else warn('vite /api proxy', `returned ${proxied?.status ?? 'no response'} — the bridge must be running for this to work`)
  } catch (error) {
    fail('vite dev server', error.message)
  }
}

// --------------------------------------------------------------- LAN access
const lanAddresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
  (list ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => ({ name, address: entry.address })))

if (!lanAddresses.length) {
  warn('LAN address', 'no non-internal IPv4 interface found')
} else {
  const primary = lanAddresses[0]
  pass('LAN address', `http://${primary.address}:${PORTS.vite}/ on ${primary.name}`)
  const reachable = await listenProbe(PORTS.vite, primary.address)
  if (reachable) pass('LAN reachability', 'the dashboard is listening on the network interface')
  else warn('LAN reachability', `not listening on ${primary.address} - run \`npm run dev:lan\` (and PI_LAN=1 on the bridge) to open it to other devices`)
}

// ------------------------------------------------------------------ report
for (const line of lines) {
  const tag = line.ok === true ? 'PASS' : line.ok === false ? 'FAIL' : 'WARN'
  console.log(`${tag}  ${line.name}${line.detail ? ` — ${line.detail}` : ''}`)
}
const fails = lines.filter((l) => l.ok === false).length
const warns = lines.filter((l) => l.ok === null).length
console.log(`\n${lines.length - fails - warns} pass, ${warns} warn, ${fails} fail`)
if (fails) {
  console.log('Fix the FAIL lines above before testing the dashboard.')
  process.exitCode = 1
} else if (!bridgeUp || !viteUp) {
  console.log('Next: npm run agent-server  (terminal 1)  &&  npm run dev  (terminal 2)')
}
