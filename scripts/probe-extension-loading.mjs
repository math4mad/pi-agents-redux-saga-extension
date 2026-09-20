#!/usr/bin/env node
// Which ways actually load a project extension, and which need trust?
//
// This decides the remote-runner design: if `-e` works untrusted, a second Mac
// never needs a saved trust decision for the squad tools to exist.
//
// Run: node scripts/probe-extension-loading.mjs [path/to/extension.ts]
import { spawn } from 'node:child_process'

const EXTENSION = process.argv[2] ?? '.pi/extensions/agent-desk.ts'
const MARKER = 'agent-desk:'

/** One throwaway pi process; the extension self-reports on stderr. */
function attempt(label, args) {
  return new Promise((resolve) => {
    const child = spawn('pi', args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    const finish = (result) => { clearTimeout(timer); child.kill('SIGKILL'); resolve({ label, args, result }) }
    const timer = setTimeout(() => finish(stderr.trim() ? `no marker; stderr: ${stderr.trim().slice(0, 120)}` : 'no marker; stderr empty'), 30000)

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.includes(MARKER)) finish(stderr.match(/agent-desk: .*/)[0].trim())
    })
    child.on('error', (error) => finish(`spawn error: ${error.message}`))
  })
}

const cases = [
  ['A  no trust, no -e      ', ['--mode', 'rpc', '--no-session']],
  ['B  no trust, with -e    ', ['--mode', 'rpc', '--no-session', '-e', EXTENSION]],
  ['C  trust (-a)           ', ['--mode', 'rpc', '--no-session', '-a']],
]

console.log(`extension: ${EXTENSION}\n`)
const results = []
for (const [label, args] of cases) {
  const outcome = await attempt(label, args)
  const loaded = outcome.result.includes(MARKER)
  results.push({ ...outcome, loaded })
  console.log(`${loaded ? 'LOADED    ' : 'NOT LOADED'}  ${label}  ${outcome.result}`)
}

const b = results.find((r) => r.label.startsWith('B'))
console.log('')
if (b?.loaded) {
  console.log('Conclusion: -e loads the extension without any trust decision, so remote runners')
  console.log('can be launched as `ssh host "PI_ROLE=crew pi --mode rpc -e <path>"` and get the')
  console.log('squad tools immediately. Prefer -e remotely: it grants one file, not the project.')
} else {
  console.log('Conclusion: -e did NOT load the extension untrusted. Remote runners then need a')
  console.log('saved trust decision on that machine, which is a real deployment step.')
}
