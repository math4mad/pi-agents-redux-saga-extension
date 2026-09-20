const http = require('node:http')
const { spawn } = require('node:child_process')

const PORT = Number(process.env.BRIDGE_PORT ?? 8787)
const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1'
const SELF_URL = `http://${HOST}:${PORT}`

// A squad is the set of pi processes behind one project. Exactly one member
// holds the line with the user; the rest are heads-down.
const SQUADS = {
  duo: [
    { role: 'desk', name: 'Desk sergeant', kind: 'Front of house', frontDesk: true },
    { role: 'crew', name: 'Detective', kind: 'Field work', frontDesk: false },
  ],
  trio: [
    { role: 'desk', name: 'Desk sergeant', kind: 'Front of house', frontDesk: true },
    { role: 'crew', name: 'Detective', kind: 'Field work', frontDesk: false },
    { role: 'lab', name: 'Tech', kind: 'Back-up analysis', frontDesk: false },
  ],
}

const squadName = process.env.PI_SQUAD ?? 'duo'
const squad = SQUADS[squadName]
if (!squad) {
  console.error(`Unknown squad "${squadName}". Known: ${Object.keys(SQUADS).join(', ')}`)
  process.exit(1)
}
// Enforced here as well as in the store: a squad nobody answers with is not a
// squad, it is a spinner with extra steps.
if (!squad.some((member) => member.frontDesk)) {
  console.error(`Squad "${squadName}" has no front-desk member; refusing to start.`)
  process.exit(1)
}
const DESK = squad.find((member) => member.frontDesk)
const FIELD = squad.filter((member) => !member.frontDesk)

// Ranks: how much a job touches, and therefore how much trust it needs.
const RANKS = ['officer', 'detective', 'sergeant']
// PI_APPROVAL_RANK names the highest rank that may run on its own. 'officer'
// (the default) gates everything that can change something; 'sergeant' opens
// the gate completely.
const AUTO_RANK = process.env.PI_APPROVAL_RANK ?? 'officer'
if (!RANKS.includes(AUTO_RANK)) {
  console.error(`Unknown PI_APPROVAL_RANK "${AUTO_RANK}". Known: ${RANKS.join(', ')}`)
  process.exit(1)
}
const rankNeedsApproval = (rank) => RANKS.indexOf(rank) > RANKS.indexOf(AUTO_RANK)

// One project for now; the map is per project so more can be added by config.
const projects = new Map([
  ['local', { path: process.env.PI_PROJECT_PATH ?? process.cwd(), roster: squad }],
])

const clients = new Set()
/** projectId -> role -> child process */
const children = new Map()
/** projectId -> role -> { busy: boolean } */
const activity = new Map()
/** request id -> resolve */
const pending = new Map()
/** jobs the desk asked for that no human has signed off yet */
const heldJobs = new Map()
function broadcast(projectId, event) {
  const payload = `data: ${JSON.stringify({ project: projectId, ...event })}\n\n`
  for (const response of clients) response.write(payload)
}

function tag(projectId, member) {
  return {
    project: projectId,
    role: member.role,
    agentId: `${projectId}:${member.role}`,
    frontDesk: member.frontDesk === true,
  }
}

function isBusy(projectId, role) {
  return activity.get(projectId)?.[role]?.busy === true
}

function noteFrame(projectId, member, frame) {
  const group = activity.get(projectId) ?? {}
  const state = group[member.role] ?? { busy: false }
  if (frame.type === 'agent_start') state.busy = true
  if (frame.type === 'agent_settled' || frame.type === 'turn_end') state.busy = false
  group[member.role] = state
  activity.set(projectId, group)
}

function memberOf(projectId, role) {
  return projects.get(projectId)?.roster.find((item) => item.role === role)
}

function startMember(projectId, member) {
  const running = children.get(projectId)?.[member.role]
  if (running && running.exitCode === null && running.signalCode === null) return running

  const project = projects.get(projectId)
  const args = ['--mode', 'rpc', '--no-session', '--name', `${projectId}:${member.role}`]
  // pi --mode rpc never prompts for trust: without this the project's own
  // .pi/extensions are silently skipped. Opt in explicitly with BRIDGE_TRUST=1.
  if (process.env.BRIDGE_TRUST === '1') args.push('-a')

  let child
  try {
    child = spawn('pi', args, {
      cwd: project.path,
      env: {
        ...process.env,
        // How the extension inside this session knows who it is.
        PI_BRIDGE_URL: process.env.PI_BRIDGE_URL ?? SELF_URL,
        PI_PROJECT: projectId,
        PI_ROLE: member.role,
        PI_FRONT_DESK: member.frontDesk === true ? '1' : '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    broadcast(projectId, { type: 'bridge_closed', ...tag(projectId, member), detail: `Could not start pi: ${error.message}` })
    return null
  }

  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        broadcast(projectId, { type: 'bridge_error', errorMessage: 'Pi returned invalid JSON', ...tag(projectId, member) })
        continue
      }

      noteFrame(projectId, member, frame)

      // Correlate a command response with whoever asked for it.
      if (frame.type === 'response' && frame.id && pending.has(frame.id)) {
        pending.get(frame.id)(frame)
        pending.delete(frame.id)
      }

      broadcast(projectId, { ...frame, ...tag(projectId, member) })

      // A crew member finishing is the desk's cue to report to the user. The
      // crew never speaks to the user itself.
      if (!member.frontDesk && frame.type === 'agent_settled') {
        reportToDesk(projectId, member)
      }
    }
  })
  child.stderr.on('data', (chunk) => broadcast(projectId, { type: 'bridge_log', detail: chunk.toString().trim(), ...tag(projectId, member) }))
  child.on('close', (code) => {
    noteFrame(projectId, member, { type: 'agent_settled' })
    broadcast(projectId, { type: 'bridge_closed', detail: `Pi ${member.role} exited with code ${code ?? 'unknown'}`, ...tag(projectId, member) })
    const group = children.get(projectId)
    if (group) delete group[member.role]
  })
  child.on('error', (error) => broadcast(projectId, { type: 'bridge_closed', detail: error.message, ...tag(projectId, member) }))

  children.set(projectId, { ...(children.get(projectId) ?? {}), [member.role]: child })
  return child
}

/** Write a command to a member's stdin. Uses pi's own queue when it is busy. */
function deliver(projectId, member, message, forcedType) {
  const child = startMember(projectId, member)
  if (!child || !child.stdin.writable) return false
  const type = forcedType ?? (isBusy(projectId, member.role) ? 'follow_up' : 'prompt')
  child.stdin.write(`${JSON.stringify({ id: `request-${Date.now()}`, type, message })}\n`)
  return true
}

function askMember(projectId, member, command, extra) {
  const child = children.get(projectId)?.[member.role]
  if (!child || !child.stdin.writable) return Promise.resolve(null)
  const id = `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve(null)
    }, 20000)
    pending.set(id, (frame) => {
      clearTimeout(timer)
      resolve(frame)
    })
    child.stdin.write(`${JSON.stringify({ id, type: command, ...extra })}\n`)
  })
}

async function reportToDesk(projectId, member) {
  const frame = await askMember(projectId, member, 'get_last_assistant_text')
  const summary = frame?.success ? frame?.data?.text : null
  if (!summary) return
  const desk = memberOf(projectId, DESK.role)
  broadcast(projectId, {
    type: 'job_reported',
    detail: summary.slice(0, 400),
    target: `${projectId}:${desk.role}`,
    ...tag(projectId, member),
  })
  deliver(
    projectId,
    desk,
    `Report from ${projectId}:${member.role}:\n\n${summary.slice(0, 4000)}\n\nTell the user what this means for what they asked for, in your own words.`,
  )
}

function squadFrame(projectId) {
  const project = projects.get(projectId)
  return {
    type: 'squad',
    project: projectId,
    // The dashboard shows the safety posture, so it has to come from the bridge
    // that actually enforces it rather than from a default in the UI.
    autoRank: AUTO_RANK,
    // "Is anything gated at all", so the dashboard can state its posture even
    // when the ladder sits mid-way (detective auto, sergeant held).
    approvalRequired: rankNeedsApproval('sergeant'),
    roster: project.roster.map((member) => ({
      id: `${projectId}:${member.role}`,
      name: member.name,
      role: member.kind,
      frontDesk: member.frontDesk === true,
    })),
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) reject(new Error('Payload too large'))
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

const json = (response, status, payload) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  response.end(JSON.stringify(payload))
}

const parseJson = async (request) => JSON.parse(await readBody(request))

async function handleReply(request, response, projectId) {
  let payload
  try {
    payload = parseJson(request)
  } catch (error) {
    return json(response, 400, { accepted: false, error: error.message })
  }
  const { message, ticketId } = await payload
  if (typeof message !== 'string' || !message.trim()) return json(response, 400, { accepted: false, error: 'A message is required' })
  if (!projects.has(projectId)) return json(response, 404, { accepted: false, error: `unknown project ${projectId}` })

  // Acknowledge-before-work is the whole point of the desk, so the bridge does
  // it: the user hears back the instant the message is accepted, whatever the
  // agents do next. Verified by test/bridge.test.mjs with a silent pi.
  broadcast(projectId, {
    type: 'user_ack',
    ticketId: typeof ticketId === 'number' ? ticketId : null,
    ...tag(projectId, DESK),
  })

  const desk = memberOf(projectId, DESK.role)
  if (!deliver(projectId, desk, message)) {
    return json(response, 502, { accepted: false, error: 'The desk agent could not be started' })
  }
  // 'follow_up' is chosen when the desk is mid-turn, so an idea added in the
  // middle of a conversation is queued rather than dropped.
  return json(response, 202, { accepted: true, ticketId: ticketId ?? null, to: `${projectId}:${desk.role}`, queued: isBusy(projectId, desk.role) })
}

async function handleEscalate(request, response, projectId) {
  const payload = await parseJson(request).catch((error) => ({ error: error.message }))
  const { question, blocking, from } = payload
  if (typeof question !== 'string' || !question.trim()) return json(response, 400, { accepted: false, error: 'A question is required' })
  const desk = memberOf(projectId, DESK.role)
  if (!desk) return json(response, 404, { accepted: false, error: `no desk agent for ${projectId}` })

  const sender = memberOf(projectId, from ?? payload.role) ?? FIELD[0]
  if (blocking === true) {
    // The wait moves onto the user. This is the one state that must never be
    // confused with "still working", so it is broadcast unconditionally.
    broadcast(projectId, { type: 'request_input', detail: question.trim(), from: sender ? `${projectId}:${sender.role}` : null, ...tag(projectId, desk) })
  } else {
    broadcast(projectId, { type: 'bridge_log', detail: `${sender?.role ?? 'crew'}: ${question.trim()}`, ...tag(projectId, sender ?? DESK) })
  }

  const delivered = deliver(
    projectId,
    desk,
    `${projectId}:${sender?.role ?? 'crew'} needs a decision: ${question.trim()}\n\nDecide it yourself if you can. If it is genuinely the user's call, ask them with ask_user and tell them what you are waiting on.`,
  )
  return json(response, delivered ? 202 : 502, { accepted: delivered, to: `${projectId}:${desk.role}`, blocking: blocking === true })
}

async function handleAsk(request, response, projectId) {
  const payload = await parseJson(request).catch((error) => ({ error: error.message }))
  const { question, ticketId } = payload
  if (typeof question !== 'string' || !question.trim()) return json(response, 400, { accepted: false, error: 'A question is required' })
  const desk = memberOf(projectId, DESK.role)
  if (!desk) return json(response, 404, { accepted: false, error: `no desk agent for ${projectId}` })

  // The desk is the asker, so this is genuinely front-desk traffic: the wait
  // moves from the squad to the user.
  broadcast(projectId, { type: 'request_input', detail: question.trim(), ticketId: typeof ticketId === 'number' ? ticketId : null, ...tag(projectId, desk) })
  return json(response, 202, { accepted: true, from: `${projectId}:${desk.role}`, ticketId: ticketId ?? null })
}

async function handleDispatch(request, response, projectId) {
  const payload = await parseJson(request).catch((error) => ({ error: error.message }))
  const { job, targetRole, ticketId } = payload
  if (typeof job !== 'string' || !job.trim()) return json(response, 400, { accepted: false, error: 'A job description is required' })
  const project = projects.get(projectId)
  if (!project) return json(response, 404, { accepted: false, error: `unknown project ${projectId}` })
  const target = (targetRole ? memberOf(projectId, targetRole) : null) ?? FIELD[0] ?? project.roster.find((member) => !member.frontDesk)
  if (!target) return json(response, 409, { accepted: false, error: `${projectId} has no field member to dispatch to` })

  const jobId = `job-${Date.now()}`
  const rank = RANKS.includes(payload.rank) ? payload.rank : 'detective'
  // An agent asking for work is not the same as a human agreeing to it. Work at
  // or above the gate waits here; an explicit per-job request always wins.
  const needsApproval = typeof payload.requiresApproval === 'boolean'
    ? payload.requiresApproval
    : rankNeedsApproval(rank)
  const brief = job.trim()
  const message = `Job ${jobId} [${rank}]${ticketId ? ` (user request #${ticketId})` : ''}, approved by the operator: ${brief}\n\nWhen you finish, the desk reports to the user, so leave a clear summary. If you are blocked on a decision, use escalate_to_desk rather than guessing.`

  if (needsApproval) {
    heldJobs.set(jobId, { projectId, targetRole: target.role, message, brief, ticketId: ticketId ?? null, rank })
    broadcast(projectId, { type: 'job_pending', jobId, rank, detail: brief.slice(0, 400), target: `${projectId}:${target.role}`, ticketId: ticketId ?? null, autoDispatch: false, ...tag(projectId, target) })
    return json(response, 202, { accepted: true, jobId, to: `${projectId}:${target.role}`, rank, awaitingApproval: true, confirmations: rank === 'sergeant' ? 2 : 1 })
  }

  if (!deliver(projectId, target, message)) {
    return json(response, 502, { accepted: false, error: `could not start ${projectId}:${target.role}` })
  }
  broadcast(projectId, { type: 'job_dispatched', jobId, rank, detail: brief.slice(0, 400), ticketId: ticketId ?? null, target: `${projectId}:${target.role}`, autoDispatch: true, ...tag(projectId, target) })
  return json(response, 202, { accepted: true, jobId, to: `${projectId}:${target.role}`, rank, awaitingApproval: false, queued: isBusy(projectId, target.role) })
}

async function handleApprove(request, response, _projectId) {
  const payload = await parseJson(request).catch((error) => ({ error: error.message }))
  const held = heldJobs.get(payload.jobId)
  if (!held) return json(response, 409, { accepted: false, error: `no job awaiting approval named ${payload.jobId}` })
  // The two-click rule for sergeant work lives with the human interface, not
  // here: a single POST means a person asked for it, and the store cannot
  // re-open a job this endpoint already reported as released.
  const target = memberOf(held.projectId, held.targetRole)
  if (!target) return json(response, 409, { accepted: false, error: `${held.projectId}:${held.targetRole} is gone` })
  if (!deliver(held.projectId, target, held.message)) {
    return json(response, 502, { accepted: false, error: `could not start ${held.projectId}:${held.targetRole}` })
  }
  heldJobs.delete(payload.jobId)
  broadcast(held.projectId, { type: 'job_dispatched', jobId: payload.jobId, detail: held.brief.slice(0, 400), ticketId: held.ticketId, target: `${held.projectId}:${target.role}`, approvedBy: 'operator', ...tag(held.projectId, target) })
  return json(response, 202, { accepted: true, jobId: payload.jobId, to: `${held.projectId}:${target.role}` })
}

async function handleDecline(request, response, _projectId) {
  const payload = await parseJson(request).catch((error) => ({ error: error.message }))
  const held = heldJobs.get(payload.jobId)
  if (!held) return json(response, 409, { accepted: false, error: `no job awaiting approval named ${payload.jobId}` })
  heldJobs.delete(payload.jobId)
  const reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim() : 'the operator declined it'
  // The desk has to be told, or it keeps waiting on work that will never run.
  broadcast(held.projectId, { type: 'job_declined', jobId: payload.jobId, detail: `Job ${payload.jobId} was not taken: ${reason}. Tell the user and propose something else.`, target: `${held.projectId}:${held.targetRole}`, ...tag(held.projectId, DESK) })
  deliver(held.projectId, memberOf(held.projectId, DESK.role), `The operator declined job ${payload.jobId} ("${held.brief}"): ${reason}. Tell the user, and propose an alternative if there is an obvious one.`)
  return json(response, 202, { accepted: true, jobId: payload.jobId })
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const projectId = url.searchParams.get('project') ?? 'local'

  if (request.method === 'GET' && url.pathname === '/api/events') {
    if (!projects.has(projectId)) return json(response, 404, { accepted: false, error: `unknown project ${projectId}` })
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    response.write(': connected\n\n')
    clients.add(response)
    // The dashboard adopts the squad as soon as it connects.
    response.write(`data: ${JSON.stringify(squadFrame(projectId))}\n\n`)
    request.on('close', () => clients.delete(response))
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/status') {
    return json(response, 200, {
      accepted: true,
      squad: squadName,
      projects: [...projects.keys()],
      desk: `${projectId}:${DESK.role}`,
      running: Object.keys(children.get(projectId) ?? {}),
      awaitingApproval: [...heldJobs.keys()],
      autoRank: AUTO_RANK,
      approvalRequired: rankNeedsApproval('sergeant'),
    })
  }

  const routes = {
    '/api/reply': handleReply,
    '/api/ask': handleAsk,
    '/api/escalate': handleEscalate,
    '/api/dispatch': handleDispatch,
    '/api/approve': handleApprove,
    '/api/decline': handleDecline,
  }
  if (request.method === 'POST' && routes[url.pathname]) {
    routes[url.pathname](request, response, projectId).catch((error) => json(response, 500, { accepted: false, error: error.message }))
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/prompt') {
    parseJson(request)
      .then((payload) => {
        const { message, role } = payload
        if (typeof message !== 'string' || !message.trim()) return json(response, 400, { accepted: false, error: 'A prompt message is required' })
        const member = memberOf(projectId, role) ?? DESK
        if (!deliver(projectId, member, message)) return json(response, 502, { accepted: false, error: 'Pi could not be started' })
        return json(response, 202, { accepted: true, to: `${projectId}:${member.role}` })
      })
      .catch((error) => json(response, 400, { accepted: false, error: error.message }))
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/queue') {
    parseJson(request)
      .then((payload) => {
        const member = memberOf(projectId, payload.role)
        const child = member && children.get(projectId)?.[member.role]
        if (!child) return json(response, 409, { accepted: false, error: `no running ${payload.role ?? 'agent'} for ${projectId}` })
        child.stdin.write(`${JSON.stringify({ id: `request-${Date.now()}`, type: payload.command ?? 'follow_up', message: String(payload.message ?? '') })}\n`)
        return json(response, 202, { accepted: true, to: `${projectId}:${member.role}` })
      })
      .catch((error) => json(response, 400, { accepted: false, error: error.message }))
    return
  }

  json(response, 404, { accepted: false, error: 'Not found' })
})

server.listen(PORT, HOST, () => {
  const roster = [...projects].map(([id, project]) => `${id}: ${project.roster.map((m) => `${m.role}${m.frontDesk ? '*' : ''}`).join(', ')}`).join(' | ')
  console.log(`Pi RPC bridge on http://${HOST}:${PORT}  (* = holds the line)  ${roster}`)
})
