// The conversation plane: tickets, mechanical acknowledgement, lanes, and the
// invariant that a squad always leaves somebody on the desk.
// Run: node test/conversation.test.mjs

const sources = []

class FakeEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  constructor(url) {
    this.url = url
    this.readyState = FakeEventSource.OPEN
    this.closed = false
    sources.push(this)
  }
  // Real SSE: every open connection receives every frame. Both the always-on
  // watcher and the current run subscribe, so the fake must fan out too.
  emit(event) { for (const other of sources) if (!other.closed) other.onmessage?.({ data: JSON.stringify(event) }) }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED }
}
globalThis.EventSource = FakeEventSource

const posts = []
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body)
  posts.push({ url, ...body })
  return { ok: true, status: 202, json: async () => ({ accepted: true }) }
}

const {
  store, requestRun, startRun, submitUserMessage, autoAck, deskSays, assignSquad,
  selectUnanswered, selectInFlight, selectAwaitingUser, selectAckLatencies, selectDesk, selectApprovalRequired, median, formatSeconds, ticketState,
} = await import('../src/store.ts')

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const settle = () => new Promise((r) => setTimeout(r, 30))
const s = () => store.getState().agents
const chat = () => s().chat
const last = (list) => list[list.length - 1]

console.log('\n[A] the ask is a ticket from the instant it lands\n')
store.dispatch(submitUserMessage({ text: '把 learning rate 那块再跑一遍' }))
check('ticket opened', s().tickets.length === 1)
check('starts unanswered', selectUnanswered(s()).length === 1)
check('ticketState is open', ticketState(s().tickets[0]) === 'open')
check('user line is on the conversation plane', last(chat()).from === 'user' && last(chat()).kind === 'user')
check('blank messages open nothing', (store.dispatch(submitUserMessage({ text: '   ' })), s().tickets.length === 1))

console.log('\n[B] somebody picks up, before any work happens\n')
store.dispatch(autoAck({ ticketId: s().tickets[0].id }))
check('ack closes the unanswered gap', selectUnanswered(s()).length === 0)
check('ack opens in-flight', selectInFlight(s()).length === 1)
check('ticketState is acknowledged', ticketState(s().tickets[0]) === 'acknowledged')
check('auto-ack echoes what the user said', last(chat()).kind === 'auto-ack' && last(chat()).text.includes('learning rate'), last(chat()).text)
const ackEntry = last(chat())
store.dispatch(autoAck({ ticketId: s().tickets[0].id }))
check('a second ack changes nothing', last(chat()) === ackEntry && s().tickets[0].ackAt === s().tickets[0].ackAt)
check('ack of an unknown ticket is inert', (store.dispatch(autoAck({ ticketId: 9999 })), last(chat()) === ackEntry))

console.log('\n[C] reply closes the loop, FIFO\n')
store.dispatch(submitUserMessage({ text: '第二个问题' }))
check('two tickets, newest first', s().tickets[0].text === '第二个问题' && s().tickets[1].text.includes('learning'))
store.dispatch(deskSays({ text: '第一个已经排上了', kind: 'reply' }))
check('reply answers the oldest open ticket', s().tickets[1].answeredAt !== null && s().tickets[0].answeredAt === null)
check('ticketState reaches answered', ticketState(s().tickets[1]) === 'answered')
check('the fresh question is the only unanswered one', selectUnanswered(s()).length === 1)
check('nothing is in flight until it is acknowledged', selectInFlight(s()).length === 0)

console.log('\n[D] the wait can move back onto the user\n')
const asked = s().tickets[0]
store.dispatch(deskSays({ text: '用旧数据还是重跑基线?', kind: 'question', ticketId: asked.id }))
check('question is flagged needsInput', last(chat()).kind === 'question' && last(chat()).needsInput === true)
check('selectAwaitingUser sees it', selectAwaitingUser(s()).length === 1)
check('the desk agent is marked awaiting', selectDesk(s())?.awaitingUser === true, String(selectDesk(s())?.awaitingUser))
check('asking does not answer the ticket', s().tickets.find((ticket) => ticket.id === asked.id)?.answeredAt === null)
store.dispatch(submitUserMessage({ text: '重跑基线' }))
check('any user input clears the hold', selectAwaitingUser(s()).length === 0 && selectDesk(s())?.awaitingUser === false)

console.log('\n[E] squad assembly needs a desk\n')
store.dispatch(assignSquad({
  project: 'nypd',
  roster: [
    { id: 'nypd:desk', name: 'Sgt. Miller', role: 'Desk sergeant', frontDesk: true },
    { id: 'nypd:field', name: 'Det. Reyes', role: 'Field work' },
    { id: 'nypd:lab', name: 'Tech Okafor', role: 'Back-up analysis' },
  ],
}))
check('three-person squad is accepted', s().agents.length === 3 && s().squadError === null)
check('exactly one holds the line', s().agents.filter((a) => a.frontDesk).length === 1)
check('squad names reach the roster', s().agents.some((a) => a.name === 'Tech Okafor'))
check('active project follows the squad', s().activeProject === 'nypd', s().activeProject)

const before = s().agents
store.dispatch(assignSquad({
  project: 'nypd',
  roster: [{ id: 'nypd:solo', name: 'Det. Nobody-Answers', role: 'All field, no desk' }],
}))
check('a desk-less squad is refused', s().squadError !== null && s().agents === before)
check('the refusal says why', String(s().squadError).includes('no desk agent'), String(s().squadError))
store.dispatch(assignSquad({ project: 'nypd', roster: [] }))
check('an empty squad is refused too', s().squadError !== null && s().agents === before)
check('rejected squads do not hijack the project', s().activeProject === 'nypd')

// The policy has to arrive on the wire, since the bridge is what enforces it.
const trioRoster = [
  { id: 'nypd:desk', name: 'Orchestrator', role: 'Lead agent', frontDesk: true },
  { id: 'nypd:field', name: 'Det. Reyes', role: 'Field work' },
  { id: 'nypd:lab', name: 'Tech Okafor', role: 'Back-up analysis' },
]
sources[0].emit({ type: 'squad', project: 'nypd', roster: trioRoster, approvalRequired: false })
await settle()
check('a squad frame can open the gate', s().autoRank === 'sergeant' && selectApprovalRequired(s()) === false)
sources[0].emit({ type: 'squad', project: 'nypd', roster: trioRoster, approvalRequired: true })
await settle()
check('and close it again', s().autoRank === 'officer' && selectApprovalRequired(s()) === true)
sources[0].emit({ type: 'squad', project: 'nypd', roster: [{ id: 'nypd:solo', name: 'Lonely' }] })
await settle()
check('a rejected squad leaves the policy alone', selectApprovalRequired(s()) === true)

console.log('\n[F] first-response latency is measurable\n')
check('latencies recorded', selectAckLatencies(s()).length >= 1, `${selectAckLatencies(s()).length} samples`)
check('median of one', median([1.2]) === 1.2)
check('median of even set', median([1, 2, 3, 4]) === 2.5)
check('median of none is null', median([]) === null)
check('sub-10s formats to one decimal', formatSeconds(1.234) === '1.2s', formatSeconds(1.234))
check('slow formats to whole seconds', formatSeconds(42.6) === '43s')
check('no sample reads as unknown', formatSeconds(null) === '--')

console.log('\n[G] the saga routes by lane, not by guesswork\n')
// The queue is FIFO: the oldest acknowledged-waiting question goes first.
const queued = s().tickets.filter((ticket) => ticket.ackAt === null).at(-1)
store.dispatch(requestRun())
await settle()
const source = last(sources)
const posted = last(posts)
check('an open ticket becomes the job', posted.url === '/api/reply', posted.url)
check('the user\u2019s own words are the prompt', posted.message === queued.text, `${posted.message} vs ${queued.text}`)
check('the ticket id round-trips', posted.ticketId === queued.id, `${posted.ticketId} vs ${queued.id}`)
check('the squad project is sent', posted.project === 'nypd', posted.project)

const eventsBefore = s().events.length
source.emit({ type: 'message_update', frontDesk: true, agentId: 'nypd:desk', assistantMessageEvent: { type: 'text_delta', delta: '收到, ' } })
source.emit({ type: 'message_update', frontDesk: true, agentId: 'nypd:desk', assistantMessageEvent: { type: 'text_delta', delta: '我先排一下' } })
await settle()
check('desk deltas do not touch the activity feed', s().events.length === eventsBefore)
check('unfinished desk text is not shown yet', !chat().some((entry) => entry.text.includes('我先排一下')))
source.emit({ type: 'message_end', frontDesk: true, agentId: 'nypd:desk' })
await settle()
check('completed desk text reaches the conversation', chat().some((entry) => entry.text === '收到, 我先排一下'), last(chat()).text)
check('and still never lands in activity', s().events.length === eventsBefore)

const unansweredBefore = selectUnanswered(s()).length
source.emit({ type: 'user_ack', ticketId: queued.id })
await settle()
check('bridge user_ack acknowledges the queued ticket',
  s().tickets.find((ticket) => ticket.id === queued.id)?.ackAt !== null && selectUnanswered(s()).length === unansweredBefore - 1)
check('and the desk echoes it into the conversation',
  chat().some((entry) => entry.kind === 'auto-ack' && entry.text === `Got it - "${queued.text}" is with the desk.`))

source.emit({ type: 'agent_end', frontDesk: true })
await settle()
check('the desk settling does not end the run', source.closed === false)

// Bridge frames the desk tools produce have to reach the same reducers the
// unit tests drive by hand.
source.emit({ type: 'request_input', frontDesk: true, agentId: 'nypd:desk', detail: '旧数据还是重跑基线?' })
await settle()
check('a request_input frame puts the wait on the user',
  last(chat()).kind === 'question' && last(chat()).needsInput === true && s().agents.find((a) => a.frontDesk)?.awaitingUser === true)

const activityBefore = s().events.length
source.emit({ type: 'job_dispatched', frontDesk: false, agentId: 'nypd:field', target: 'nypd:field', detail: '重跑 sweep' })
await settle()
check('a dispatched job shows up as activity', s().events.length === activityBefore + 1)
check('and is attributed to the crew member', s().events[0].agent === 'Det. Reyes', s().events[0].agent)
source.emit({ type: 'job_reported', frontDesk: false, agentId: 'nypd:field', detail: 'sweep done' })
await settle()
check('a crew report releases that member', s().agents.find((a) => a.id === 'nypd:field')?.status === 'waiting',
  s().agents.find((a) => a.id === 'nypd:field')?.status)

source.emit({ type: 'agent_settled' })
await settle()
check('the crew settling ends the run', source.closed === true)

console.log('\n[H] the human gate\n')
{
  const { decideJob, selectPendingApproval } = await import('../src/store.ts')
  const pending = () => selectPendingApproval(s())

  const eventsBefore = s().events.length
  sources[0].emit({ type: 'job_pending', jobId: 'job-1', detail: '重跑 5 seeds 的 sweep', target: 'nypd:field', ticketId: 3 })
  await settle()
  check('a proposed job lands in the ledger', s().jobs.some((job) => job.id === 'job-1' && job.state === 'awaiting_approval'))
  check('it shows up as needing approval', pending().some((job) => job.id === 'job-1'))
  check('proposing work does not start work', s().agents.find((a) => a.id === 'nypd:field')?.status !== 'working')
  check('the proposal itself adds no activity entry', s().events.length === eventsBefore,
    `${s().events.length - eventsBefore} extra entries`)

  sources[0].emit({ type: 'job_pending', jobId: 'job-1', detail: 'duplicate' })
  await settle()
  check('a duplicate proposal is ignored', s().jobs.filter((job) => job.id === 'job-1').length === 1)

  posts.length = 0
  store.dispatch(decideJob({ id: 'job-1', approved: true }))
  await settle()
  check('approval moves the job to running', s().jobs.find((job) => job.id === 'job-1')?.state === 'running')
  check('approval is sent to the bridge',
    posts.some((p) => p.url === '/api/approve' && p.jobId === 'job-1'), JSON.stringify(posts.map((p) => p.url)))
  check('the project travels with the decision', posts.find((p) => p.url === '/api/approve')?.project === 'nypd')

  store.dispatch(decideJob({ id: 'job-1', approved: true }))
  await settle()
  check('a job cannot be decided twice', posts.filter((p) => p.url === '/api/approve').length === 1)

  sources[0].emit({ type: 'job_pending', jobId: 'job-2', detail: '往 main 里提交东西' })
  await settle()
  posts.length = 0
  store.dispatch(decideJob({ id: 'job-2', approved: false, reason: '  不要动 main  ' }))
  await settle()
  check('decline marks it declined', s().jobs.find((job) => job.id === 'job-2')?.state === 'declined')
  check('the reason is trimmed and kept', s().jobs.find((job) => job.id === 'job-2')?.reason === '不要动 main')
  check('decline posts to /api/decline with the reason',
    posts.some((p) => p.url === '/api/decline' && p.reason === '不要动 main'), JSON.stringify(posts.map((p) => p.url)))
  posts.length = 0
  store.dispatch(decideJob({ id: 'job-2', approved: true }))
  await settle()
  check('a declined job cannot be revived', s().jobs.find((job) => job.id === 'job-2')?.state === 'declined' && posts.length === 0)

  sources[0].emit({ type: 'job_pending', jobId: 'job-3', detail: '跑一次 lint' })
  await settle()
  store.dispatch(decideJob({ id: 'job-3', approved: true }))
  await settle()
  sources[0].emit({ type: 'job_dispatched', jobId: 'job-3', target: 'nypd:field', detail: '跑一次 lint' })
  await settle()
  check('a dispatched job is on the activity feed', s().events.some((entry) => entry.action === 'Job taken'))
  check('and leaves the approval queue', !pending().some((job) => job.id === 'job-3'))
  sources[0].emit({ type: 'job_reported', agentId: 'nypd:field', detail: 'lint clean' })
  await settle()
  check('the report settles the job it belongs to', s().jobs.find((job) => job.id === 'job-3')?.state === 'settled')
  check('and releases the crew member', s().agents.find((a) => a.id === 'nypd:field')?.status === 'waiting')

  sources[0].emit({ type: 'job_pending', jobId: 'job-4', detail: '另一个还没批的' })
  await settle()
  store.dispatch(startRun())
  check('a new run does not wipe the approval queue', pending().some((job) => job.id === 'job-4'))
  check('declined and settled work stays on the ledger',
    s().jobs.filter((job) => ['job-2', 'job-3'].includes(job.id)).length === 2)

  console.log('\n[H2] the rank ladder inside the store\n')
  sources[0].emit({ type: 'job_pending', jobId: 'job-s', rank: 'sergeant', detail: '清空 results 目录', target: 'nypd:field' })
  await settle()
  const sergeant = () => s().jobs.find((job) => job.id === 'job-s')
  check('a sergeant job is recorded at its rank', sergeant()?.rank === 'sergeant', sergeant()?.rank)
  check('and owes two confirmations', sergeant()?.confirmations === 2, String(sergeant()?.confirmations))

  posts.length = 0
  store.dispatch(decideJob({ id: 'job-s', approved: true }))
  await settle()
  check('the first confirmation does not release the job', sergeant()?.state === 'awaiting_approval', sergeant()?.state)
  check('and nothing reaches the bridge', posts.length === 0, JSON.stringify(posts.map((p) => p.url)))
  check('one confirmation is now owed', sergeant()?.confirmations === 1)

  store.dispatch(decideJob({ id: 'job-s', approved: true }))
  await settle()
  check('the second confirmation releases it', sergeant()?.state === 'running')
  check('and the bridge is told once', posts.filter((p) => p.url === '/api/approve').length === 1, JSON.stringify(posts.map((p) => p.url)))

  sources[0].emit({ type: 'job_pending', jobId: 'job-s2', rank: 'sergeant', detail: '强推远端' })
  await settle()
  posts.length = 0
  store.dispatch(decideJob({ id: 'job-s2', approved: false, reason: '不推' }))
  await settle()
  check('declining a sergeant job needs only one click',
    s().jobs.find((job) => job.id === 'job-s2')?.state === 'declined' && posts.length === 1 && posts[0].url === '/api/decline',
    JSON.stringify(posts.map((p) => p.url)))

  sources[0].emit({ type: 'job_pending', jobId: 'job-o', rank: 'officer', detail: '读日志', autoDispatch: true })
  await settle()
  const officerJob = s().jobs.find((job) => job.id === 'job-o')
  check('work under the ladder arrives already running', officerJob?.state === 'running' && officerJob?.rank === 'officer')
  check('and it never enters the approval queue', !selectPendingApproval(s()).some((job) => job.id === 'job-o'))

  sources[0].emit({ type: 'job_pending', jobId: 'job-d', detail: '没有标 rank 的活' })
  await settle()
  check('an unranked job is treated as detective', s().jobs.find((job) => job.id === 'job-d')?.rank === 'detective',
    s().jobs.find((job) => job.id === 'job-d')?.rank)

  console.log('\n[H3] when the bridge refuses a decision\n')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 502, json: async () => ({ accepted: false, error: 'no job awaiting approval named job-x' }) })
  sources[0].emit({ type: 'job_pending', jobId: 'job-x', rank: 'sergeant', detail: '推送到远端', target: 'nypd:field' })
  await settle()
  store.dispatch(decideJob({ id: 'job-x', approved: true }))
  await settle()
  store.dispatch(decideJob({ id: 'job-x', approved: true }))
  await settle()
  globalThis.fetch = realFetch
  const refused = () => s().jobs.find((job) => job.id === 'job-x')
  check('a job the bridge never took is not left looking live', refused()?.state === 'awaiting_approval', refused()?.state)
  check('it returns to the approval queue', selectPendingApproval(s()).some((job) => job.id === 'job-x'))
  check('and owes its full confirmations again', refused()?.confirmations === 2, String(refused()?.confirmations))
  check('the refusal is visible, not swallowed', s().events.some((entry) => entry.kind === 'error' && entry.action === 'Connection lost'))
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failing: ' + failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
