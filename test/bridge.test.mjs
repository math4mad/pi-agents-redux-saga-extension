// Bridge contract: squad attribution and the ack-before-work promise, tested
// against a stub `pi` on PATH so no model is ever called.
// Run: node test/bridge.test.mjs
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bridge-'))
const binDir = path.join(tmp, 'bin')
fs.mkdirSync(binDir)

// Stands in for the real `pi`: logs how it was launched and what it is asked to
// do, echoes RPC frames back, and stays silent when PI_STUB_SILENT is set.
fs.writeFileSync(path.join(binDir, 'pi'), `#!/usr/bin/env node
const fs = require('fs')
const role = process.env.PI_ROLE
const log = (entry) => fs.appendFileSync(process.env.PI_STUB_LOG, JSON.stringify({ role, ...entry }) + '\\n')
log({ argv: process.argv.slice(2), cwd: process.cwd() })
if (process.env.PI_STUB_SILENT !== '1') {
  process.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().split('\\n').filter(Boolean)) {
      const request = JSON.parse(line)
      log({ stdin: request })
      if (request.type === 'get_last_assistant_text') {
        process.stdout.write(JSON.stringify({ id: request.id, type: 'response', command: 'get_last_assistant_text', success: true, data: { text: 'sweep done: 3 seeds, best lr 3e-4' } }) + '\\n')
      }
      if (request.type === 'prompt' || request.type === 'follow_up') {
        process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n')
        process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'read' }) + '\\n')
        process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
      }
    }
  })
}
setInterval(() => {}, 1000)
`)
fs.chmodSync(path.join(binDir, 'pi'), 0o755)

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

const launch = async ({ squad = 'duo', silent = false, autoRank = 'officer', port } = {}) => {
  const chosen = port ?? await freePort()
  // One log per bridge instance, so a check in one section cannot be satisfied
  // by traffic from an earlier one.
  const stubLog = path.join(tmp, `stub-${chosen}.log`)
  const child = spawn(process.execPath, [path.join(process.cwd(), 'server.cjs')], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(chosen),
      PI_SQUAD: squad,
      PI_APPROVAL_RANK: autoRank,
      PI_STUB_LOG: stubLog,
      PI_STUB_SILENT: silent ? '1' : '0',
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(`timeout: ${stderr.trim()}`), 8000)
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Pi RPC bridge')) { clearTimeout(timer); resolve(chunk.toString().trim()) }
    })
    child.on('exit', (code) => { clearTimeout(timer); resolve(`exited:${code} ${stderr.trim()}`) })
  })
  const readLog = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  return {
    port: chosen,
    child,
    ready,
    /** launch records (argv) for this bridge instance */
    launches: () => readLog().filter((entry) => entry.argv),
    /** a member was actually handed something to do (not polled for its output) */
    asked: (role, needle) => readLog().some((entry) => entry.role === role && JSON.stringify(entry.stdin ?? '').includes(needle)),
    askedCount: (role) => readLog().filter((entry) => entry.role === role
      && (entry.stdin?.type === 'prompt' || entry.stdin?.type === 'follow_up')).length,
  }
}

/** Live SSE consumer; waitFor lets a test await a specific frame. */
function collect(port) {
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

  const waitFor = (predicate, ms = 3000) => new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const found = frames.find(predicate)
      if (found) { clearInterval(timer); resolve(found) }
      else if (Date.now() - started > ms) { clearInterval(timer); resolve(null) }
    }, 20)
  })

  return { frames, waitFor, stop: async () => { controller.abort(); await pump } }
}

/** Poll a condition that depends on an async hop (stdin write, child stdout). */
const until = async (predicate, ms = 3000) => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

const post = async (port, endpoint, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, payload: await response.json() }
}


console.log('\n[A] squad registration is announced on connect\n')
{
  const { port, child, ready, launches, asked } = await launch()
  console.log(`   ${ready}`)
  const feed = collect(port)
  const squad = await feed.waitFor((frame) => frame.type === 'squad')
  check('squad frame arrives before any agent activity', !!squad)
  check('roster ids are addressable by the store', squad?.roster?.every((m) => m.id.startsWith('local:')))
  check('exactly one member holds the line', squad?.roster?.filter((m) => m.frontDesk).length === 1)
  check('the desk member is named', squad?.roster?.[0]?.name === 'Desk sergeant', squad?.roster?.[0]?.name)
  check('the squad frame declares the approval posture', squad?.approvalRequired === true, JSON.stringify(squad?.approvalRequired))

  const empty = await post(port, '/api/reply', { message: '   ', ticketId: 1 })
  check('empty reply rejected', empty.status === 400 && empty.payload.accepted === false, JSON.stringify(empty.payload))
  check('a rejected reply spawns no agent', launches().length === 0, `${launches().length} launches`)
  check('nobody has been asked to work yet', asked('desk', 'prompt') === false)
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()
  check('status endpoint names the desk', status.desk === 'local:desk' && status.squad === 'duo', JSON.stringify(status))

  const legacy = await post(port, '/api/prompt', { message: '' })
  check('legacy /api/prompt still rejects empty prompts', legacy.status === 400, JSON.stringify(legacy.payload))
  const defaultProject = await post(port, '/api/reply', { message: 'hello', ticketId: 2 })
  check('a reply with no ?project lands on the default project', defaultProject.status === 202 && /local:/.test(defaultProject.payload.to), JSON.stringify(defaultProject.payload))

  const reply = await post(port, '/api/reply', { message: '把基线重跑一遍', ticketId: 42 })
  check('reply accepted with its ticket', reply.status === 202 && reply.payload.ticketId === 42, JSON.stringify(reply.payload))
  check('routed to the desk, not the crew', String(reply.payload.to).endsWith(':desk'), reply.payload.to)

  // The earlier default-project reply acked ticket 2, so match on the id too.
  const ack = await feed.waitFor((frame) => frame.type === 'user_ack' && frame.ticketId === 42)
  check('user_ack broadcast for the right ticket', !!ack)
  check('user_ack is attributed to the desk', ack?.frontDesk === true && /:desk$/.test(String(ack?.agentId)))

  const started = await feed.waitFor((frame) => frame.type === 'agent_start')
  check('agent frames survive the JSON hop tagged', started?.project === 'local' && started?.role === 'desk', JSON.stringify(started))
  check('desk frames are marked frontDesk', started?.frontDesk === true)

  const crew = await post(port, '/api/prompt', { message: 'inspect the repo', role: 'crew' })
  check('/api/prompt can address a specific role', crew.status === 202 && /:crew$/.test(crew.payload.to), crew.payload.to)
  const crewFrame = await feed.waitFor((frame) => frame.role === 'crew' && frame.type === 'agent_start')
  check('crew frames are not front-desk traffic', !!crewFrame && crewFrame.frontDesk === false)
  const launchRecords = launches()
  check('the desk member is launched with a session name',
    launchRecords.some((entry) => entry.argv.includes('local:desk')))
  check('rpc mode is used for every member', launchRecords.length > 0 && launchRecords.every((entry) => entry.argv.includes('--mode')))
  check('each member is told which role it holds',
    launches().some((entry) => entry.role === 'crew') && launches().some((entry) => entry.role === 'desk'))

  await feed.stop()
  child.kill('SIGKILL')
}

console.log('\n[B] the ack does not depend on the agent answering\n')
{
  const { port, child, ready } = await launch({ silent: true })
  check('silent-agent bridge still starts', ready.startsWith('Pi RPC bridge'), ready)
  const feed = collect(port)
  await feed.waitFor((frame) => frame.type === 'squad')
  const reply = await post(port, '/api/reply', { message: '中途再加一个想法', ticketId: 7 })
  check('reply accepted even with a silent agent', reply.status === 202)
  const ack = await feed.waitFor((frame) => frame.type === 'user_ack')
  check('acknowledged although the agent said nothing', !!ack && ack.ticketId === 7, JSON.stringify(ack ?? null))
  const silence = feed.frames.filter((frame) => frame.type === 'agent_start')
  check('and no agent frame was faked to make that true', silence.length === 0, `${silence.length} frames`)
  await feed.stop()
  child.kill('SIGKILL')
}

console.log('\n[C] squad shapes\n')
{
  const { port, child, ready } = await launch({ squad: 'trio' })
  check('trio squad starts', ready.startsWith('Pi RPC bridge'), ready)
  const feed = collect(port)
  const squad = await feed.waitFor((frame) => frame.type === 'squad')
  check('three members for a medium project', squad?.roster?.length === 3, JSON.stringify(squad?.roster?.map((m) => m.id)))
  check('still exactly one desk in a trio', squad?.roster?.filter((m) => m.frontDesk).length === 1)
  check('back-up analyst exists and is not at the desk',
    !!squad?.roster?.find((m) => m.id === 'local:lab' && m.frontDesk === false))
  await feed.stop()
  child.kill('SIGKILL')
}

{
  const bad = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'server.cjs')], {
      env: { ...process.env, BRIDGE_PORT: '0', PI_SQUAD: 'squad-with-no-desk' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('exit', (code) => resolve({ code, out: out.trim() }))
  })
  check('an unknown squad refuses to start', bad.code === 1 && bad.out.includes('Unknown squad'), `code=${bad.code} ${bad.out}`)
}

console.log('\n[D] ask / escalate / dispatch, and the loop back to the user\n')
{
  const { port, child, asked } = await launch()
  const feed = collect(port)
  await feed.waitFor((frame) => frame.type === 'squad')

  check('/api/ask needs a question', (await post(port, '/api/ask', {})).status === 400)
  const ask = await post(port, '/api/ask', { question: '旧数据还是重跑基线?', ticketId: 5 })
  check('/api/ask accepted', ask.status === 202 && ask.payload.from === 'local:desk', JSON.stringify(ask.payload))
  const input = await feed.waitFor((frame) => frame.type === 'request_input')
  check('request_input reaches the stream as front-desk traffic', input?.frontDesk === true)
  check('request_input is attributed to the desk', /:desk$/.test(String(input?.agentId)), JSON.stringify(input?.agentId))
  check('request_input carries the question the user must read', input?.detail === '旧数据还是重跑基线?', input?.detail)
  check('asking the user starts no agent work of its own',
    !feed.frames.some((frame) => frame.type === 'agent_start'))

  check('/api/dispatch needs a job', (await post(port, '/api/dispatch', { job: '   ' })).status === 400)
  // Approval is on by default now; this section is about the dispatch/report
  // loop, so it waives the gate explicitly.
  const dispatch = await post(port, '/api/dispatch', { job: '重跑 sweep', ticketId: 5, requiresApproval: false })
  check('an explicit waiver dispatches at once',
    dispatch.status === 202 && dispatch.payload.awaitingApproval === false, JSON.stringify(dispatch.payload))
  check('dispatch falls back to the first field member',
    dispatch.status === 202 && dispatch.payload.to === 'local:crew', JSON.stringify(dispatch.payload))
  const jobFrame = await feed.waitFor((frame) => frame.type === 'job_dispatched')
  check('job_dispatched is activity, not dialogue', jobFrame?.frontDesk === false, JSON.stringify(jobFrame?.frontDesk))
  check('job_dispatched names the target', jobFrame?.target === 'local:crew', jobFrame?.target)

  const report = await feed.waitFor((frame) => frame.type === 'job_reported', 8000)
  check('a settling crew member reports through the bridge', !!report, JSON.stringify(report?.type ?? null))
  check('the report carries the crew summary', String(report?.detail).includes('best lr 3e-4'), report?.detail)
  check('the report is attributed to the crew', report?.frontDesk === false && /:crew$/.test(String(report?.agentId)))
  await new Promise((resolve) => setTimeout(resolve, 400))
  check('the desk is woken with the crew report', asked('desk', 'Report from local:crew'))
  check('and told to phrase it for the user', asked('desk', 'Tell the user what this means'))
  check('the crew is never told to address the user', !asked('crew', 'Tell the user'))

  const nonBlocking = await post(port, '/api/escalate', { question: 'fyi: seed 43 differs', role: 'crew' })
  check('a non-blocking escalation is accepted', nonBlocking.status === 202 && nonBlocking.payload.blocking === false)
  check('it lands as a log line',
    !!(await feed.waitFor((frame) => frame.type === 'bridge_log' && String(frame.detail).includes('seed 43'))))
  check('and does not claim the user is needed',
    !feed.frames.some((frame) => frame.type === 'request_input' && String(frame.detail).includes('seed 43')))

  const blocking = await post(port, '/api/escalate', { question: 'which checkpoint counts as the baseline?', role: 'crew', blocking: true })
  check('a blocking escalation is accepted', blocking.status === 202)
  const crewAsk = await feed.waitFor((frame) => frame.type === 'request_input' && String(frame.detail).includes('checkpoint'))
  check('a blocked crew member surfaces through the desk', /:desk$/.test(String(crewAsk?.agentId)), JSON.stringify(crewAsk?.agentId))
  check('while still crediting who is blocked', crewAsk?.from === 'local:crew', crewAsk?.from)
  check('and the desk is asked to decide or escalate', asked('desk', 'needs a decision'))

  await feed.stop()
  child.kill('SIGKILL')
}

console.log('\n[E] the approval gate at the bridge\n')
{
  const { port, child, asked, askedCount } = await launch()
  const feed = collect(port)
  await feed.waitFor((frame) => frame.type === 'squad')

  const dispatch = await post(port, '/api/dispatch', { job: '重跑 sweep', ticketId: 9 })
  check('dispatch defaults to needing a signature', dispatch.payload.awaitingApproval === true, JSON.stringify(dispatch.payload))
  const pendingFrame = await feed.waitFor((frame) => frame.type === 'job_pending')
  check('job_pending carries the job id', pendingFrame?.jobId === dispatch.payload.jobId)
  check('a held job is not marked as started', pendingFrame?.autoDispatch === false)
  check('the crew has been asked to do nothing', askedCount('crew') === 0, `${askedCount('crew')} prompts`)

  check('approving an unknown job is refused', (await post(port, '/api/approve', { jobId: 'job-nope' })).status === 409)
  check('declining an unknown job is refused', (await post(port, '/api/decline', { jobId: 'job-nope' })).status === 409)

  const approve = await post(port, '/api/approve', { jobId: dispatch.payload.jobId })
  check('approval released the job', approve.status === 202 && approve.payload.to === 'local:crew', JSON.stringify(approve.payload))
  const startedFrame = await feed.waitFor((frame) => frame.type === 'job_dispatched')
  check('approval turns into job_dispatched', startedFrame?.jobId === dispatch.payload.jobId)
  check('and only now is the crew asked', await until(() => asked('crew', 'approved by the operator')))
  check('the crew is asked exactly once', askedCount('crew') === 1, `${askedCount('crew')} prompts`)
  check('a job cannot be approved twice', (await post(port, '/api/approve', { jobId: dispatch.payload.jobId })).status === 409)

  const second = await post(port, '/api/dispatch', { job: '往 main 里提交' })
  const decline = await post(port, '/api/decline', { jobId: second.payload.jobId, reason: '不要动 main' })
  check('decline accepted', decline.status === 202)
  const declined = await feed.waitFor((frame) => frame.type === 'job_declined')
  check('job_declined carries the human reason', String(declined?.detail).includes('不要动 main'), declined?.detail)
  check('the desk is told, so it stops waiting', await until(() => asked('desk', 'declined job')))
  check('the declined job never reached the crew', !asked('crew', '往 main'))

  await feed.stop()
  child.kill('SIGKILL')
}

console.log('\n[F] the rank ladder decides what reaches a human\n')
{
  const { port, child, asked } = await launch()
  const feed = collect(port)
  const squad = await feed.waitFor((frame) => frame.type === 'squad')
  check('the ladder is announced on the wire', squad?.autoRank === 'officer' && squad?.approvalRequired === true, JSON.stringify(squad?.autoRank))

  const officer = await post(port, '/api/dispatch', { job: '只看一眼日志', rank: 'officer' })
  check('officer work runs under the gate', officer.payload.awaitingApproval === false, JSON.stringify(officer.payload))
  check('the rank travels on the response', officer.payload.rank === 'officer')
  check('and the crew really was asked', await until(() => asked('crew', '只看一眼日志')))
  const officerFrame = await feed.waitFor((f) => f.type === 'job_dispatched' && f.rank === 'officer')
  check('the stream carries the rank', !!officerFrame && officerFrame.autoDispatch === true)

  const detective = await post(port, '/api/dispatch', { job: '改一下配置文件', rank: 'detective' })
  check('detective work is held', detective.payload.awaitingApproval === true)
  check('and owes one signature', detective.payload.confirmations === 1, JSON.stringify(detective.payload.confirmations))
  const sergeant = await post(port, '/api/dispatch', { job: '清掉 results 目录', rank: 'sergeant' })
  check('sergeant work is held too', sergeant.payload.awaitingApproval === true)
  check('and owes two', sergeant.payload.confirmations === 2, JSON.stringify(sergeant.payload.confirmations))
  const heldFrame = await feed.waitFor((f) => f.type === 'job_pending' && f.rank === 'sergeant')
  check('a held job shows its rank on the wire', !!heldFrame)
  check('neither held job reached the crew', !asked('crew', '改一下配置文件') && !asked('crew', '清掉 results 目录'))

  const bogus = await post(port, '/api/dispatch', { job: '随便看看', rank: 'chief' })
  check('an unknown rank falls back to detective', bogus.payload.rank === 'detective', JSON.stringify(bogus.payload.rank))
  const forced = await post(port, '/api/dispatch', { job: '再读一次 README', rank: 'officer', requiresApproval: true })
  check('an explicit per-job request outranks the ladder', forced.payload.awaitingApproval === true)

  await feed.stop()
  child.kill('SIGKILL')
}

console.log('\n[G] the ladder can be moved by configuration\n')
{
  const wide = await launch({ autoRank: 'detective' })
  const feed = collect(wide.port)
  const squad = await feed.waitFor((frame) => frame.type === 'squad')
  check('a wider ladder is announced', squad?.autoRank === 'detective' && squad?.approvalRequired === true, JSON.stringify(squad?.approvalRequired))
  const detective = await post(wide.port, '/api/dispatch', { job: '改配置文件', rank: 'detective' })
  check('detective now runs on its own', detective.payload.awaitingApproval === false)
  check('the crew gets it', await until(() => wide.asked('crew', '改配置文件')))
  const sergeant = await post(wide.port, '/api/dispatch', { job: '删分支', rank: 'sergeant' })
  check('sergeant is still held', sergeant.payload.awaitingApproval === true)
  await feed.stop()
  wide.child.kill('SIGKILL')

  const open = await launch({ autoRank: 'sergeant' })
  const openFeed = collect(open.port)
  const openSquad = await openFeed.waitFor((frame) => frame.type === 'squad')
  check('an open ladder says so', openSquad?.autoRank === 'sergeant' && openSquad?.approvalRequired === false, JSON.stringify(openSquad))
  const anything = await post(open.port, '/api/dispatch', { job: '强推远端', rank: 'sergeant' })
  check('with the gate fully open nothing is held', anything.payload.awaitingApproval === false)
  check('and the crew is asked immediately', await until(() => open.asked('crew', '强推远端')))
  const override = await post(open.port, '/api/dispatch', { job: '一个小改动', requiresApproval: true })
  check('a per-job demand for approval still holds', override.payload.awaitingApproval === true)
  await openFeed.stop()
  open.child.kill('SIGKILL')

  const bad = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(process.cwd(), 'server.cjs')], {
      env: { ...process.env, BRIDGE_PORT: '0', PI_APPROVAL_RANK: 'lieutenant' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stderr.on('data', (chunk) => { out += chunk })
    proc.on('exit', (code) => resolve({ code, out: out.trim() }))
  })
  check('an unknown PI_APPROVAL_RANK refuses to start', bad.code === 1 && bad.out.includes('Unknown PI_APPROVAL_RANK'), `code=${bad.code} ${bad.out}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failing: ' + failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
