// Plays the demo bridge the way a person would, and asserts that everything
// the dashboard is supposed to show actually arrives. No pi, no model.
// Run: node test/demo-bridge.test.mjs
import { spawn } from 'node:child_process'
import net from 'node:net'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

const port = await freePort()
const child = spawn(process.execPath, ['scripts/demo-bridge.cjs'], {
  cwd: process.cwd(),
  env: { ...process.env, BRIDGE_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const started = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 8000)
  child.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('demo bridge')) { clearTimeout(timer); resolve(chunk.toString().trim()) }
  })
  child.on('exit', (code) => { clearTimeout(timer); resolve(`exited:${code}`) })
})
console.log(`\n[A] the bridge comes up on its own\n`)
check('demo bridge starts', typeof started === 'string' && started.startsWith('demo bridge'), String(started))

const frames = []
const controller = new AbortController()
const pump = fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal })
  .then(async (response) => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try { frames.push(JSON.parse(line.slice(6))) } catch { /* ignore partials */ }
        }
      }
    }
  })
  .catch((error) => { if (error.name !== 'AbortError') throw error })

const waitFor = (predicate, ms = 9000) => new Promise((resolve) => {
  const started = Date.now()
  const timer = setInterval(() => {
    const found = frames.find(predicate)
    if (found) { clearInterval(timer); resolve(found) }
    else if (Date.now() - started > ms) { clearInterval(timer); resolve(null) }
  }, 25)
})
const post = async (endpoint, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, payload: await response.json() }
}

console.log('\n[B] the squad is announced, and the desk introduces itself\n')
const squad = await waitFor((frame) => frame.type === 'squad')
check('squad frame arrives first', !!squad)
check('three roles, one of them the desk', squad?.roster?.length === 3 && squad?.roster?.filter((m) => m.frontDesk).length === 1)
check('the approval posture travels on the wire', squad?.autoRank === 'officer' && squad?.approvalRequired === true)
const intro = await waitFor((frame) => frame.type === 'message_end' && frame.frontDesk === true)
check('the desk says something without being asked', !!intro)

console.log('\n[C] one message, the whole room reacts\n')
const reply = await post('/api/reply', { message: '重跑一遍 sweep' })
check('the reply is accepted with a ticket', reply.status === 202 && reply.payload.ticketId === 1, JSON.stringify(reply.payload))
const ack = await waitFor((frame) => frame.type === 'user_ack')
check('acknowledged before any work', !!ack && ack.ticketId === 1)

const crewTool = await waitFor((frame) => frame.type === 'tool_execution_end' && frame.role === 'crew')
check('crew activity is attributed to crew', !!crewTool && crewTool.frontDesk === false)
const labTool = await waitFor((frame) => frame.type === 'tool_execution_end' && frame.role === 'lab')
check('the back-up analyst shows up as a third seat', !!labTool && labTool.agentId === 'demo:lab')
const log = await waitFor((frame) => frame.type === 'bridge_log')
check('a stderr line reaches the activity feed', !!log && String(log.detail).includes('loss'))

const question = await waitFor((frame) => frame.type === 'request_input')
check('the desk asks the user something', !!question && question.frontDesk === true, question?.detail?.slice(0, 40))

const pending = await waitFor((frame) => frame.type === 'job_pending')
check('a job is proposed rather than started', !!pending && pending.autoDispatch === false)
check('and it is the destructive rank', pending?.rank === 'sergeant', pending?.rank)
const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()
check('the bridge lists it as awaiting approval', status.awaitingApproval.includes(pending?.jobId), JSON.stringify(status.awaitingApproval))

console.log('\n[D] approving releases the work\n')
const approve = await post('/api/approve', { jobId: pending.jobId })
check('approval accepted', approve.status === 202 && approve.payload.accepted === true)
const dispatched = await waitFor((frame) => frame.type === 'job_dispatched')
check('job_dispatched follows the approval', dispatched?.jobId === pending.jobId)
const reported = await waitFor((frame) => frame.type === 'job_reported')
check('the crew reports back', !!reported && String(reported.detail).includes('81.2'), reported?.detail)
const closing = await waitFor((frame) => frame.type === 'message_end' && frames.lastIndexOf(frame) > frames.lastIndexOf(reported))
check('and the desk comes back to the user about it', !!closing)
check('the job left the queue', !(await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).awaitingApproval.length)

console.log('\n[E] declining, and refusing to invent a job\n')
await post('/api/reply', { message: '再来一轮' })
const second = await waitFor((frame) => frame.type === 'job_pending' && frame.jobId !== pending.jobId)
check('a second ask proposes a second job', !!second)
const decline = await post('/api/decline', { jobId: second.jobId, reason: '先别动 results' })
check('decline accepted', decline.status === 202)
const declined = await waitFor((frame) => frame.type === 'job_declined')
check('the desk is told it was declined', !!declined && String(declined.detail).includes('先别动 results'), declined?.detail?.slice(0, 50))
check('the declined job is gone from the queue',
  !(await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).awaitingApproval.includes(second.jobId))
check('approving a declined job is refused', (await post('/api/approve', { jobId: second.jobId })).status === 409)
check('an empty message is refused', (await post('/api/reply', { message: '  ' })).status === 400)

await controller.abort()
await pump
child.kill('SIGKILL')

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failing: ' + failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
