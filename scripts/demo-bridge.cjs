#!/usr/bin/env node
// A scripted stand-in for server.cjs. Same SSE contract, no pi, no model, no
// tokens: it plays back a realistic squad conversation so you can see what the
// dashboard does before wiring up real agents.
//
// Run: npm run demo     then open the URL vite prints
const http = require('node:http')

const PORT = Number(process.env.BRIDGE_PORT ?? 8787)
const HOST = process.env.PI_LAN ? '0.0.0.0' : '127.0.0.1'
const AUTO_RANK = process.env.PI_APPROVAL_RANK ?? 'officer'

const RANKS = ['officer', 'detective', 'sergeant']
const gated = (rank) => RANKS.indexOf(rank) > RANKS.indexOf(AUTO_RANK)

const DESK = { project: 'demo', role: 'desk', agentId: 'demo:desk', frontDesk: true }
const CREW = { project: 'demo', role: 'crew', agentId: 'demo:crew', frontDesk: false }
const LAB = { project: 'demo', role: 'lab', agentId: 'demo:lab', frontDesk: false }

const clients = new Set()

function say(member, event) {
  const payload = `data: ${JSON.stringify({ ...event, ...member })}\n\n`
  for (const res of clients) res.write(payload)
}

/** Stream a sentence the way pi does: thinking, then text deltas, then end. */
function speak(member, text, { delay = 26 } = {}) {
  const words = text.split(' ')
  const lines = []
  for (let i = 0; i < words.length; i += 3) lines.push(words.slice(i, i + 3).join(' ') + ' ')
  lines.forEach((delta, index) => {
    setTimeout(() => {
      if (index === 0) say(member, { type: 'agent_start' })
      say(member, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
    }, delay * (index + 1))
  })
  setTimeout(() => say(member, { type: 'message_end' }), delay * (lines.length + 1))
}

const held = new Map()
let ticketSeq = 0

// ---------------------------------------------------------------- scenarios

/** The desk answers, proposes destructive work, and the gate catches it. */
function scenarioTicket(ticketId, message) {
  speak(DESK, `收到。我把"${message.slice(0, 40)}"记下来了,先让 crew 跑一遍基线,有结果我立刻回来告诉你。`)

  setTimeout(() => {
    say(CREW, { type: 'agent_start' })
    say(CREW, { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'call-1' })
  }, 1400)
  setTimeout(() => say(CREW, { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'call-1', isError: false }), 2600)
  // The third seat earns its place: the back-up analyst checks the numbers.
  setTimeout(() => say(LAB, { type: 'tool_execution_start', toolName: 'read', toolCallId: 'call-lab' }), 2800)
  setTimeout(() => say(LAB, { type: 'tool_execution_end', toolName: 'read', toolCallId: 'call-lab', isError: false }), 3300)
  setTimeout(() => say(CREW, { type: 'bridge_log', detail: 'epoch 3: loss 0.412, lr 3e-4' }), 3000)
  // A crew member that needs the human, routed through the desk.
  setTimeout(() => {
    say(DESK, { type: 'request_input', detail: '3 seeds 已经跑完。要不要把旧 results/ 清掉再跑剩下的 5 个?这会删文件。', ticketId })
  }, 3600)

  // And a job the desk proposes at a rank that cannot run unattended.
  setTimeout(() => {
    const jobId = `job-${Date.now()}`
    held.set(jobId, { jobId, rank: 'sergeant', brief: '清空 results/ 后跑剩余 5 seeds', ticketId })
    say(CREW, { type: 'job_pending', jobId, rank: 'sergeant', detail: '清空 results/ 后跑剩余 5 seeds', target: 'demo:crew', ticketId, autoDispatch: false })
  }, 4200)
}

function release(jobId) {
  const job = held.get(jobId)
  if (!job) return false
  held.delete(jobId)
  say(CREW, { type: 'job_dispatched', jobId, rank: job.rank, detail: job.brief, target: 'demo:crew', autoDispatch: true, approvedBy: 'operator' })
  setTimeout(() => {
    say(CREW, { type: 'agent_start' })
    say(CREW, { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'call-2' })
  }, 500)
  setTimeout(() => say(CREW, { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'call-2', isError: false }), 1800)
  setTimeout(() => say(CREW, { type: 'job_reported', detail: '5 seeds 跑完:mean 81.2 ± 0.6,最优 lr 3e-4' }), 2100)
  setTimeout(() => speak(DESK, '批准的那个活干完了:5 seeds 跑完,均值 81.2 ± 0.6,最优还是 lr 3e-4。要我把这组数字写进报告吗?'), 2400)
  return true
}

function decline(jobId, reason) {
  const job = held.get(jobId)
  if (!job) return false
  held.delete(jobId)
  say(DESK, { type: 'job_declined', jobId, detail: `操作员没有批准这个工单${reason ? `:${reason}` : ''}。我会用另一种方式继续,先不动 results/。` })
  setTimeout(() => speak(DESK, `那条我没让 crew 执行${reason ? ` —— ${reason}` : ''}。要不我们只读旧的 3 seeds 结果,先出一版对比图?`), 700)
  return true
}

// ------------------------------------------------------------------- server

const readBody = (req) => new Promise((resolve) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } })
})

const send = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)

  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    response.write(': connected\n\n')
    response.write(`data: ${JSON.stringify({
      type: 'squad',
      project: 'demo',
      autoRank: AUTO_RANK,
      approvalRequired: gated('sergeant'),
      roster: [
        { id: 'demo:desk', name: 'Desk sergeant', role: 'Front of house', frontDesk: true },
        { id: 'demo:crew', name: 'Detective', role: 'Field work', frontDesk: false },
        { id: 'demo:lab', name: 'Tech', role: 'Back-up analysis', frontDesk: false },
      ],
    })}\n\n`)
    clients.add(response)
    setTimeout(() => speak(DESK, '演示模式:下面的一切都是脚本,不调用模型、不花 token。在下面的输入框里说一句你想让我做的事,看看内勤怎么接话。'), 600)
    request.on('close', () => clients.delete(response))
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/status') {
    return send(response, 200, { accepted: true, squad: 'trio', demo: true, projects: ['demo'], desk: 'demo:desk', running: [], awaitingApproval: [...held.keys()], autoRank: AUTO_RANK, approvalRequired: gated('sergeant') })
  }

  if (request.method === 'POST' && url.pathname === '/api/reply') {
    const { message, ticketId } = await readBody(request)
    if (typeof message !== 'string' || !message.trim()) return send(response, 400, { accepted: false, error: 'A message is required' })
    const id = typeof ticketId === 'number' ? ticketId : ++ticketSeq
    // Acknowledged before any work, exactly like the real bridge.
    say(DESK, { type: 'user_ack', ticketId: id })
    scenarioTicket(id, message)
    return send(response, 202, { accepted: true, ticketId: id, to: 'demo:desk', queued: false })
  }

  if (request.method === 'POST' && url.pathname === '/api/dispatch') {
    const { job, rank } = await readBody(request)
    const jobId = `job-${Date.now()}`
    const heldRank = RANKS.includes(rank) ? rank : 'detective'
    if (gated(heldRank)) {
      held.set(jobId, { jobId, rank: heldRank, brief: job })
      say(CREW, { type: 'job_pending', jobId, rank: heldRank, detail: job, target: 'demo:crew', autoDispatch: false })
      return send(response, 202, { accepted: true, jobId, to: 'demo:crew', rank: heldRank, awaitingApproval: true, confirmations: heldRank === 'sergeant' ? 2 : 1 })
    }
    say(CREW, { type: 'job_dispatched', jobId, rank: heldRank, detail: job, target: 'demo:crew', autoDispatch: true })
    return send(response, 202, { accepted: true, jobId, to: 'demo:crew', rank: heldRank, awaitingApproval: false })
  }

  if (request.method === 'POST' && url.pathname === '/api/ask') {
    const { question } = await readBody(request)
    if (typeof question !== 'string' || !question.trim()) return send(response, 400, { accepted: false, error: 'A question is required' })
    say(DESK, { type: 'request_input', detail: question.trim() })
    return send(response, 202, { accepted: true, from: 'demo:desk' })
  }

  if (request.method === 'POST' && (url.pathname === '/api/approve' || url.pathname === '/api/decline')) {
    const { jobId, reason } = await readBody(request)
    if (!held.has(jobId)) return send(response, 409, { accepted: false, error: `no job awaiting approval named ${jobId}` })
    if (url.pathname === '/api/approve') release(jobId)
    else decline(jobId, reason)
    return send(response, 202, { accepted: true, jobId })
  }

  if (request.method === 'POST' && url.pathname === '/api/prompt') {
    const { message } = await readBody(request)
    if (typeof message !== 'string' || !message.trim()) return send(response, 400, { accepted: false, error: 'A prompt message is required' })
    say(CREW, { type: 'agent_start' })
    setTimeout(() => say(CREW, { type: 'tool_execution_start', toolName: 'read' }), 400)
    setTimeout(() => say(CREW, { type: 'agent_settled' }), 1200)
    return send(response, 202, { accepted: true, to: 'demo:crew' })
  }

  send(response, 404, { accepted: false, error: 'Not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`demo bridge (no pi, no tokens) on http://${HOST}:${PORT}`)
  console.log(`ladder: ${AUTO_RANK} auto, everything above it needs a signature`)
  console.log('open the dashboard and type anything into the message box')
})
