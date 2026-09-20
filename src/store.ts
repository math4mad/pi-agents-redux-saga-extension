import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import createSagaMiddleware, { type SagaIterator } from 'redux-saga'
import { END, eventChannel, type EventChannel } from 'redux-saga'
import { all, call, fork, put, select, take, takeEvery, takeLatest } from 'redux-saga/effects'

export type AgentStatus = 'working' | 'waiting' | 'done' | 'error'

export interface Agent {
  id: string
  name: string
  role: string
  status: AgentStatus
  task: string
  accent: string
  custom?: boolean
  /** 内勤: owns the conversation with the user. A squad needs at least one. */
  frontDesk?: boolean
  /** True while the desk is waiting on the user, not on a job. */
  awaitingUser?: boolean
}

export interface TimelineEvent {
  id: number
  agent: string
  action: string
  detail: string
  time: string
  kind: 'receive' | 'think' | 'tool' | 'complete' | 'error' | 'log'
}

const SEED_AGENTS: readonly Agent[] = [
  { id: 'orchestrator', name: 'Orchestrator', role: 'Lead agent', status: 'working', task: 'Routing the next request', accent: 'coral', frontDesk: true },
  { id: 'researcher', name: 'Researcher', role: 'Web intelligence', status: 'waiting', task: 'Ready for assignment', accent: 'mint' },
  { id: 'builder', name: 'Builder', role: 'Implementation', status: 'waiting', task: 'Ready for assignment', accent: 'blue' },
]

const ACCENTS = ['coral', 'mint', 'blue']
const STORAGE_KEY = 'pi-agents/control-room'
const MAX_NAME = 40

// eventSeq is monotonic so the stream stays ordered even when two events land
// in the same millisecond, and starts clear of the seeded ids. Declared before
// restoreAgents() runs: it advances customSeq while replaying a persisted
// roster, and a later `let` would be in the temporal dead zone by then.
let eventSeq = 100
let customSeq = 0
let ticketSeq = 0
let chatSeq = 0
const MAX_EVENTS = 60
const MAX_CHAT = 60
const MAX_TICKETS = 40
const MAX_JOBS = 25

const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

interface StoredAgent {
  id: string
  name?: string
  role?: string
  accent?: string
  custom?: boolean
  frontDesk?: boolean
}

// Names and the custom roster survive a reload; live status/task do not.
function restoreAgents(): Agent[] {
  const agents: Agent[] = SEED_AGENTS.map((agent) => ({ ...agent }))
  let stored: StoredAgent[] = []
  try {
    if (typeof localStorage !== 'undefined') {
      const snapshot = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { version?: number; agents?: StoredAgent[] } | null
      if (snapshot?.version === 1 && Array.isArray(snapshot.agents)) stored = snapshot.agents
    }
  } catch { /* corrupt or unavailable storage falls back to the seed roster */ }

  for (const item of stored) {
    if (!item || typeof item.id !== 'string') continue
    const match = agents.find((agent) => agent.id === item.id)
    if (match) {
      if (typeof item.name === 'string' && item.name.trim()) match.name = item.name.trim().slice(0, MAX_NAME)
      if (typeof item.role === 'string' && item.role.trim()) match.role = item.role.trim()
      // A squad assigned at runtime is restored as it was, desk flag included,
      // otherwise the "someone is on the line" invariant dies on reload.
      if (typeof item.frontDesk === 'boolean') match.frontDesk = item.frontDesk
      match.custom = item.custom === true
    } else if (typeof item.name === 'string' && item.name.trim()) {
      // Unknown id: either a hand-added operator or a squad member assigned at
      // runtime. Both must survive a reload or the desk goes unmanned.
      const suffix = Number(item.id.replace(/^custom-/, ''))
      if (Number.isFinite(suffix) && suffix >= customSeq) customSeq = suffix
      agents.push({
        id: item.id,
        name: item.name.trim().slice(0, MAX_NAME),
        role: (item.role ?? '').trim() || 'Custom agent',
        status: 'waiting',
        task: item.frontDesk ? 'On the line' : 'Ready for assignment',
        accent: item.accent ?? ACCENTS[0],
        custom: item.custom === true,
        frontDesk: item.frontDesk === true,
      })
    }
  }
  return agents
}

export type TicketState = 'open' | 'acknowledged' | 'answered'

/** One thing the user asked for. Lives on the conversation plane. */
export interface Ticket {
  id: number
  text: string
  createdAt: number
  ackAt: number | null
  answeredAt: number | null
}

/** A line of dialogue. Only the desk and the user ever appear here. */
export interface ChatEntry {
  id: number
  from: 'user' | 'frontDesk'
  kind: 'user' | 'auto-ack' | 'reply' | 'question'
  text: string
  ticketId: number | null
  time: string
  needsInput?: boolean
}

/** What a ticket needs from the squad, derived purely from its timestamps. */
export const ticketState = (ticket: Ticket): TicketState =>
  ticket.answeredAt !== null ? 'answered' : ticket.ackAt !== null ? 'acknowledged' : 'open'

/** A job the desk asked for. Higher ranks touch more and need more trust. */
export type JobState = 'awaiting_approval' | 'running' | 'settled' | 'declined'
export const JOB_RANKS = ['officer', 'detective', 'sergeant'] as const
export type JobRank = (typeof JOB_RANKS)[number]

/** How many times a rank needs a human to say it before it runs. */
export const confirmationsFor = (rank: JobRank): number => (rank === 'sergeant' ? 2 : 1)

export interface Job {
  id: string
  brief: string
  target: string
  requestedBy: string
  ticketId: number | null
  createdAt: number
  decidedAt: number | null
  reason: string | null
  state: JobState
  rank: JobRank
  /** Counts down the confirmations still owed; 0 means it may run. */
  confirmations: number
}

export interface AgentsState {
  agents: Agent[]
  events: TimelineEvent[]
  runNumber: number
  clearedAt: string | null
  tickets: Ticket[]
  chat: ChatEntry[]
  /** Jobs up to and including this rank run without a signature. */
  autoRank: JobRank
  jobs: Job[]
  squadError: string | null
  activeProject: string
}

const initialState: AgentsState = {
  agents: restoreAgents(),
  events: [
    { id: 3, agent: 'Orchestrator', action: 'Delegated', detail: 'Researcher is standing by', time: '09:41:08', kind: 'tool' },
    { id: 2, agent: 'Orchestrator', action: 'Planning', detail: 'Breaking request into agent tasks', time: '09:41:04', kind: 'think' },
    { id: 1, agent: 'Orchestrator', action: 'Session opened', detail: 'New task received from workspace', time: '09:41:02', kind: 'receive' },
  ],
  runNumber: 12,
  clearedAt: null,
  tickets: [],
  chat: [],
  autoRank: 'officer',
  jobs: [],
  squadError: null,
  activeProject: 'local',
}

const agentsSlice = createSlice({
  name: 'agents',
  initialState,
  reducers: {
    startRun(state) {
      state.runNumber += 1
      state.agents.forEach((agent) => {
        // Keyed on the desk flag, not the seed id, so an assigned squad still
        // leaves somebody on the line instead of everyone on standby.
        const desk = agent.frontDesk === true || agent.id === 'orchestrator'
        agent.status = desk ? 'working' : 'waiting'
        agent.task = desk ? 'On the line' : 'Ready for assignment'
      })
    },
    agentStep(state, action: PayloadAction<{ agentId: string; status: AgentStatus; task: string; event: Omit<TimelineEvent, 'id' | 'time' | 'agent'> }>) {
      const agent = state.agents.find((item) => item.id === action.payload.agentId)
      if (agent) {
        agent.status = action.payload.status
        agent.task = action.payload.task
      }
      state.events.unshift({
        // The display name is resolved here and then frozen: history keeps the
        // name the agent had at the time, later renames do not rewrite it.
        ...action.payload.event,
        agent: agent?.name ?? action.payload.agentId,
        id: ++eventSeq,
        time: clock(),
      })
      if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS
    },
    renameAgent(state, action: PayloadAction<{ id: string; name: string }>) {
      const name = action.payload.name.trim().slice(0, MAX_NAME)
      const agent = state.agents.find((item) => item.id === action.payload.id)
      if (!agent || !name || name === agent.name) return
      if (state.agents.some((item) => item.id !== agent.id && item.name.toLowerCase() === name.toLowerCase())) return
      agent.name = name
    },
    addAgent(state, action: PayloadAction<{ name: string; role?: string }>) {
      const name = action.payload.name.trim().slice(0, MAX_NAME)
      if (!name || state.agents.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) return
      state.agents.push({
        id: `custom-${++customSeq}`,
        name,
        role: (action.payload.role ?? '').trim() || 'Custom agent',
        status: 'waiting',
        task: 'Ready for assignment',
        accent: ACCENTS[state.agents.length % ACCENTS.length],
        custom: true,
      })
    },
    removeAgent(state, action: PayloadAction<{ id: string }>) {
      // The three built-in roles stay put; only added agents can be dropped.
      if (!state.agents.some((agent) => agent.id === action.payload.id && agent.custom)) return
      state.agents = state.agents.filter((agent) => agent.id !== action.payload.id)
    },
    endRun(state) {
      // No worker may stay 'working' once the run is over; deliberate 'error'
      // statuses are kept so the fault stays visible on the card.
      state.agents.forEach((agent) => {
        if (agent.id !== 'orchestrator' && agent.status === 'working') {
          agent.status = 'waiting'
          agent.task = 'Ready for assignment'
        }
      })
    },
    /** The desk proposed work; it waits here until a human signs it off. */
    jobProposed(state, action: PayloadAction<{ id: string; brief: string; target?: string; requestedBy?: string; ticketId?: number | null; autoDispatch?: boolean; rank?: JobRank }>) {
      const { id, brief, target, requestedBy, ticketId } = action.payload
      if (!id || state.jobs.some((job) => job.id === id)) return
      const rank: JobRank = JOB_RANKS.includes(action.payload.rank as JobRank) ? (action.payload.rank as JobRank) : 'detective'
      state.jobs.unshift({
        id,
        brief: (brief ?? '').trim() || 'unspecified work',
        target: target ?? 'crew',
        requestedBy: requestedBy ?? 'desk',
        ticketId: ticketId ?? null,
        createdAt: Date.now(),
        decidedAt: null,
        reason: null,
        rank,
        // autoDispatch is the bridge saying it already sent the work, which only
        // happens when the rank fell under the gate.
        state: action.payload.autoDispatch ? 'running' : 'awaiting_approval',
        confirmations: action.payload.autoDispatch ? 0 : confirmationsFor(rank),
      })
      if (state.jobs.length > MAX_JOBS) state.jobs.length = MAX_JOBS
    },
    jobRunning(state, action: PayloadAction<{ id: string }>) {
      const job = state.jobs.find((item) => item.id === action.payload.id)
      if (!job || job.state === 'declined') return
      job.state = 'running'
      job.decidedAt = job.decidedAt ?? Date.now()
    },
    jobSettled(state, action: PayloadAction<{ id?: string }>) {
      // A report carries no job id, so it closes the job that is actually open.
      const job = action.payload.id
        ? state.jobs.find((item) => item.id === action.payload.id)
        : state.jobs.find((item) => item.state === 'running')
      if (job) job.state = 'settled'
    },
    jobRefused(state, action: PayloadAction<{ id: string }>) {
      // The bridge said no: the job goes back on the queue it came from, with
      // the confirmations its rank is owed, rather than looking done.
      const job = state.jobs.find((item) => item.id === action.payload.id)
      if (!job) return
      job.state = 'awaiting_approval'
      job.decidedAt = null
      job.reason = null
      job.confirmations = confirmationsFor(job.rank)
    },
    decideJob(state, action: PayloadAction<{ id: string; approved: boolean; reason?: string; at: number }>) {
      const job = state.jobs.find((item) => item.id === action.payload.id)
      // Only a pending job can be decided; a human cannot un-run finished work.
      if (!job || job.state !== 'awaiting_approval') return
      // Declining is always safe, so it never needs a second look.
      if (action.payload.approved && job.confirmations > 1) {
        job.confirmations -= 1
        return
      }
      job.state = action.payload.approved ? 'running' : 'declined'
      // The stamp lets sendDecision recognise *this* dispatch rather than any
      // earlier decision on the same job.
      job.decidedAt = action.payload.at
      job.reason = action.payload.reason?.trim() || null
      job.confirmations = 0
    },
    clearTimeline(state) {
      state.events = []
      state.clearedAt = clock()
    },
    /** The user said something. A ticket exists from this instant. */
    submitUserMessage(state, action: PayloadAction<{ text: string }>) {
      const text = action.payload.text.trim()
      if (!text) return
      const ticket: Ticket = { id: ++ticketSeq, text, createdAt: Date.now(), ackAt: null, answeredAt: null }
      state.tickets.unshift(ticket)
      if (state.tickets.length > MAX_TICKETS) state.tickets.length = MAX_TICKETS
      // Anything the user types counts as answering the desk's open question.
      state.agents.forEach((agent) => { agent.awaitingUser = false })
      state.chat.filter((entry) => entry.needsInput).forEach((entry) => { entry.needsInput = false })
      state.chat.push({ id: ++chatSeq, from: 'user', kind: 'user', text, ticketId: ticket.id, time: clock() })
      trimChat(state)
    },
    /** Mechanical acknowledgement, echoed by the bridge the moment it accepts. */
    autoAck(state, action: PayloadAction<{ ticketId: number; echo?: string }>) {
      const ticket = state.tickets.find((item) => item.id === action.payload.ticketId)
      if (!ticket || ticket.ackAt !== null) return
      ticket.ackAt = Date.now()
      const preview = ticket.text.length > 90 ? `${ticket.text.slice(0, 89)}...` : ticket.text
      state.chat.push({
        id: ++chatSeq,
        from: 'frontDesk',
        kind: 'auto-ack',
        text: action.payload.echo ?? `Got it - "${preview}" is with the desk.`,
        ticketId: ticket.id,
        time: clock(),
      })
      trimChat(state)
    },
    /** Anything the desk says. Only 'question' may put the wait back on the user. */
    deskSays(state, action: PayloadAction<{ text: string; kind?: 'reply' | 'question'; ticketId?: number | null }>) {
      const text = action.payload.text.trim()
      if (!text) return
      const kind = action.payload.kind ?? 'reply'
      const desk = state.agents.find((agent) => agent.frontDesk)
      state.chat.push({ id: ++chatSeq, from: 'frontDesk', kind, text, ticketId: action.payload.ticketId ?? null, time: clock(), needsInput: kind === 'question' })
      if (desk) desk.awaitingUser = kind === 'question'
      if (kind === 'reply') {
        // tickets is newest-first, so findLast gives the oldest unanswered one.
        const oldest = state.tickets.findLast((ticket) => ticket.answeredAt === null)
        if (oldest) oldest.answeredAt = Date.now()
      }
      trimChat(state)
    },
    /** Squad assembly is only honoured while somebody stays on the desk. */
    assignSquad(state, action: PayloadAction<{ project: string; roster: Array<{ id: string; name?: string; role?: string; frontDesk?: boolean; accent?: string }>; approvalRequired?: boolean; autoRank?: JobRank }>) {
      const roster = action.payload.roster.filter((entry) => typeof entry.id === 'string' && entry.id.trim())
      if (!roster.length) {
        state.squadError = `${action.payload.project}: empty squad, keeping the current roster`
        return
      }
      if (!roster.some((entry) => entry.frontDesk)) {
        state.squadError = `${action.payload.project}: no desk agent in this squad, so nothing the user says would ever get an answer. Squad rejected.`
        return
      }
      state.squadError = null
      state.activeProject = action.payload.project
      if (JOB_RANKS.includes((action.payload.autoRank ?? '') as JobRank)) state.autoRank = action.payload.autoRank as JobRank
      else if (typeof action.payload.approvalRequired === 'boolean') state.autoRank = action.payload.approvalRequired ? 'officer' : 'sergeant'
      state.agents = roster.map((entry, index) => ({
        id: entry.id,
        name: (entry.name ?? '').trim() || entry.id,
        role: (entry.role ?? '').trim() || 'Field agent',
        status: entry.frontDesk ? ('working' as AgentStatus) : ('waiting' as AgentStatus),
        task: entry.frontDesk ? 'On the line' : 'Ready for assignment',
        accent: entry.accent ?? ACCENTS[index % ACCENTS.length],
        frontDesk: entry.frontDesk === true,
        awaitingUser: false,
      }))
    },
  },
})

function trimChat(state: AgentsState) {
  if (state.chat.length > MAX_CHAT) state.chat.splice(0, state.chat.length - MAX_CHAT)
}

export const { startRun, agentStep, endRun, clearTimeline, renameAgent, addAgent, removeAgent } = agentsSlice.actions
export const { submitUserMessage, autoAck, deskSays, assignSquad } = agentsSlice.actions
export const { jobProposed, jobRunning, jobSettled, jobRefused } = agentsSlice.actions
const decideJobAction = agentsSlice.actions.decideJob
/** Stamped so a second click on the same card cannot reach the bridge twice. */
export const decideJob = (input: { id: string; approved: boolean; reason?: string }) =>
  decideJobAction({ ...input, at: Date.now() })

const runRequested = { type: 'agents/runRequested' } as const
/** Synthetic event the channel emits when the SSE stream is dead for good. */
const CONNECTION_LOST = 'bridge/connection_lost'

/** Owned by watchBridge; runPiAgent must skip them or entries double up. */
const CONVERSATION_FRAMES = new Set([
  'squad', 'user_ack', 'job_pending', 'job_dispatched', 'job_reported', 'job_declined', 'request_input',
])

interface PiEvent {
  type: string
  /** Bridge attribution: which project and which member of its squad. */
  project?: string
  role?: string
  agentId?: string
  frontDesk?: boolean
  ticketId?: number
  echo?: string
  jobId?: string
  target?: string
  autoDispatch?: boolean
  approvalRequired?: boolean
  rank?: JobRank
  /** Highest rank the bridge will start without asking a human first. */
  autoRank?: JobRank
  roster?: Array<{ id: string; name?: string; role?: string; frontDesk?: boolean }>
  detail?: string
  toolName?: string
  toolCallId?: string
  isError?: boolean
  errorMessage?: string
  error?: string
  willRetry?: boolean
  assistantMessageEvent?: { type?: string; delta?: string }
}

function createPiEventChannel(): EventChannel<PiEvent> {
  return eventChannel((emit) => {
    // No EventSource means this is not a browser: server rendering, a test, or
    // a prerender. End the channel quietly instead of throwing inside the saga.
    if (typeof EventSource === 'undefined') {
      emit(END)
      return () => {}
    }
    const source = new EventSource('/api/events')
    source.onmessage = (message) => emit(JSON.parse(message.data) as PiEvent)
    source.onerror = () => {
      // EventSource retries by itself while the browser still holds the
      // socket, so only fail loudly once the stream is actually CLOSED.
      if (source.readyState === EventSource.CLOSED) {
        emit({ type: CONNECTION_LOST, detail: 'Live stream to the Pi bridge closed' })
        emit(END)
      }
    }
    return () => source.close()
  })
}

interface PromptReceipt {
  accepted?: boolean
  error?: string
}

// Never rejects: a dead bridge must degrade into UI state, not an uncaught
// error that would tear down the takeLatest watcher.
async function postJson(endpoint: string, body: Record<string, unknown>): Promise<PromptReceipt> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await response.json()) as PromptReceipt
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const sendPrompt = (message: string) => postJson('/api/prompt', { message })
const sendTicket = (project: string, ticketId: number, message: string) =>
  postJson('/api/reply', { project, ticketId, message })

const step = (agentId: string, status: AgentStatus, task: string, action: string, detail: string, kind: TimelineEvent['kind']) =>
  agentStep({ agentId, status, task, event: { action, detail, kind } })

const fault = (detail: string) => step('orchestrator', 'error', 'Connection to Pi lost', 'Connection lost', detail, 'error')

const actor = (event: PiEvent, fallback: string) => event.agentId ?? fallback

/**
 * The always-on plane: the desk's words, ticket acknowledgements, the squad
 * roster, and the job ledger. It is separate from runPiAgent on purpose: a crew
 * member can propose work long after the run that started it has ended, and
 * dropping that proposal is exactly how a queue becomes invisible.
 */
function* watchBridge(): SagaIterator {
  const channel: EventChannel<PiEvent> = yield call(createPiEventChannel)
  // What the desk has started saying but not finished.
  let deskBuffer = ''
  try {
    while (true) {
      const event: PiEvent = yield take(channel)
      switch (event.type) {
        case 'squad':
          yield put(assignSquad({
            project: event.project ?? 'local',
            roster: event.roster ?? [],
            approvalRequired: event.approvalRequired,
            autoRank: event.autoRank,
          }))
          break
        case 'user_ack':
          if (typeof event.ticketId === 'number') yield put(autoAck({ ticketId: event.ticketId, echo: event.echo }))
          break
        case 'job_pending':
          yield put(jobProposed({
            id: String(event.jobId ?? 'job'),
            brief: event.detail ?? '',
            target: event.target ?? undefined,
            requestedBy: event.agentId ?? undefined,
            ticketId: typeof event.ticketId === 'number' ? event.ticketId : null,
            autoDispatch: event.autoDispatch === true,
            rank: event.rank,
          }))
          break
        case 'job_dispatched':
          if (typeof event.jobId === 'string') yield put(jobRunning({ id: event.jobId }))
          yield put(step(actor(event, 'builder'), 'working', event.detail ?? 'Job accepted', 'Job taken', `${event.target ?? 'crew'} is on it`, 'receive'))
          break
        case 'job_reported':
          yield put(jobSettled({}))
          yield put(step(actor(event, 'builder'), 'waiting', 'Reported back to the desk', 'Job reported', event.detail ?? 'Crew member finished', 'complete'))
          break
        case 'job_declined':
          // The desk has to stop waiting on work that will never arrive.
          yield put(deskSays({ text: event.detail ?? 'A job was declined. Tell the user and move on.' }))
          break
        case 'request_input':
          // The wait moves back onto the user. Deliberately not 'working'.
          yield put(deskSays({
            text: deskBuffer.trim() || event.detail || 'The crew needs a decision before it can move.',
            kind: 'question',
            ticketId: typeof event.ticketId === 'number' ? event.ticketId : null,
          }))
          deskBuffer = ''
          break
        default:
          if (event.frontDesk && event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
            deskBuffer += event.assistantMessageEvent.delta ?? ''
          } else if (event.frontDesk && event.type === 'message_end' && deskBuffer.trim()) {
            yield put(deskSays({ text: deskBuffer.trim(), ticketId: typeof event.ticketId === 'number' ? event.ticketId : null }))
            deskBuffer = ''
          }
      }
    }
  } finally {
    channel.close()
  }
}

/**
 * A human decision is local state plus one POST. If the bridge refuses it, the
 * job goes back into the queue rather than vanishing.
 */
function* sendDecision(action: { type: string; payload: { id: string; approved: boolean; reason?: string; at: number } }): SagaIterator {
  const job: Job | undefined = yield select((state: RootState) =>
    state.agents.jobs.find((item) => item.id === action.payload.id),
  )
  // The reducer refuses decisions on jobs that were already settled, and stamps
  // the one it accepted, so a mismatch means this dispatch changed nothing.
  if (!job || job.decidedAt !== action.payload.at) return
  const project: string = yield select((state: RootState) => state.agents.activeProject)
  const endpoint = job.state === 'running' ? '/api/approve' : '/api/decline'
  const receipt: PromptReceipt = yield call(postJson, endpoint, { project, jobId: job.id, reason: job.reason })
  if (!receipt.accepted) {
    yield put(fault(`${endpoint} failed: ${receipt.error ?? 'the bridge refused the decision'}`))
    // Put it back on the queue it came from: a job the bridge never started
    // must not look like one that is running.
    yield put(jobRefused({ id: job.id }))
  }
}

function* runPiAgent(): SagaIterator {
  yield put(startRun())
  const channel: EventChannel<PiEvent> = yield call(createPiEventChannel)
  try {
    // A run exists to hand something to the desk. If the user has asked for
    // anything, that question is the job; the canned prompt is only the demo.
    const job: { id: number; text: string } | undefined = yield select(
      (state: RootState) => state.agents.tickets.findLast((ticket) => ticket.ackAt === null) ?? undefined,
    )
    let receipt: PromptReceipt
    if (job) {
      const project: string = yield select((state: RootState) => state.agents.activeProject)
      receipt = yield call(sendTicket, project, job.id, job.text)
    } else {
      receipt = yield call(sendPrompt, 'Inspect this project and give a concise status summary.')
    }
    if (!receipt.accepted) {
      yield put(fault(`Could not reach the Pi bridge: ${receipt.error ?? 'no response'}`))
      yield put(endRun())
      return
    }

    while (true) {
      const event: PiEvent = yield take(channel)
      // The conversation plane and the job ledger belong to watchBridge; acting
      // on them here as well would double every entry.
      if (event.frontDesk || CONVERSATION_FRAMES.has(event.type)) continue

      switch (event.type) {
        case 'agent_start':
          yield put(step(actor(event, 'orchestrator'), 'working', 'Pi is processing the request', 'Started', 'Agent accepted the task', 'receive'))
          break
        case 'message_update':
          if (event.assistantMessageEvent?.type === 'thinking_delta') {
            yield put(step(actor(event, 'orchestrator'), 'working', 'Thinking through the request', 'Thinking', 'Reasoning update received', 'think'))
          }
          break
        case 'tool_execution_start':
          yield put(step(actor(event, 'builder'), 'working', `Running ${event.toolName ?? 'a tool'}`, 'Tool call', event.toolName ?? 'Tool started', 'tool'))
          break
        case 'tool_execution_end':
          if (event.isError) {
            yield put(step(actor(event, 'builder'), 'error', `${event.toolName ?? 'Tool'} returned an error`, 'Tool failed', event.toolName ?? 'Tool failed', 'error'))
          } else {
            yield put(step(actor(event, 'builder'), 'waiting', `Last tool: ${event.toolName ?? 'unknown'}`, 'Tool result', `${event.toolName ?? 'Tool'} completed`, 'tool'))
          }
          break
        case 'auto_retry_start':
        case 'agent_end':
          if (event.type === 'agent_end' && !event.willRetry) {
            yield put(step(actor(event, 'orchestrator'), 'done', 'Response ready', 'Completed', 'Pi finished the request', 'complete'))
            yield put(endRun())
            return
          }
          yield put(step(actor(event, 'orchestrator'), 'working', 'Retrying after a transient error', 'Retrying', 'Pi scheduled an automatic retry', 'error'))
          break
        case 'agent_settled':
          yield put(step(actor(event, 'orchestrator'), 'done', 'Response ready', 'Completed', 'Pi run fully settled', 'complete'))
          yield put(endRun())
          return
        case 'extension_error':
        case 'bridge_error':
          // Non-fatal: log it and keep the stream open.
          yield put(step(actor(event, 'orchestrator'), 'working', 'Recovering from a bridge error', 'Bridge error', event.errorMessage ?? event.error ?? event.detail ?? 'Malformed event', 'error'))
          break
        case 'bridge_log':
          // stderr passthrough from the bridge; diagnostic only, never fatal.
          if (event.detail) {
            yield put(step(actor(event, 'researcher'), 'working', 'Watching the Pi bridge log', 'Bridge log', event.detail, 'log'))
          }
          break
        case 'bridge_closed':
        case CONNECTION_LOST:
          yield put(fault(event.detail ?? 'Pi process exited unexpectedly'))
          yield put(endRun())
          return
      }
    }
  } catch (error) {
    yield put(fault(error instanceof Error ? error.message : 'Unexpected bridge failure'))
    yield put(endRun())
  } finally {
    channel.close()
  }
}

function* rootSaga(): SagaIterator {
  yield all([
    fork(watchBridge),
    takeEvery('agents/decideJob', sendDecision),
    takeLatest(runRequested.type, runPiAgent),
  ])
}

const sagaMiddleware = createSagaMiddleware()

export const store = configureStore({
  reducer: { agents: agentsSlice.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware({ thunk: false }).concat(sagaMiddleware),
})

sagaMiddleware.run(rootSaga)

function persistRoster(agents: Agent[]) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      agents: agents.map(({ id, name, role, accent, custom, frontDesk }) => ({ id, name, role, accent, custom, frontDesk })),
    }))
  } catch { /* private browsing or a full quota must not break the dashboard */ }
}

store.subscribe(() => persistRoster(store.getState().agents.agents))

export type RootState = ReturnType<typeof store.getState>

/* ------------------------------------------------------------------ selectors
 * Everything the front page reports is derived from the ticket log, never from
 * how busy a process happens to look. They take the slice, so the dashboard and
 * the tests share one definition. */

/** Asked, never answered. The one number that must stay at zero. */
export const selectUnanswered = (state: AgentsState) =>
  state.tickets.filter((ticket) => ticket.ackAt === null)

/** Acknowledged but the work is not back yet: allowed to take its time. */
export const selectInFlight = (state: AgentsState) =>
  state.tickets.filter((ticket) => ticket.ackAt !== null && ticket.answeredAt === null)

/** The wait is on the user, not the squad. Must never be confused with above. */
export const selectAwaitingUser = (state: AgentsState) => state.chat.filter((entry) => entry.needsInput)

/** Work an agent asked for that no human has signed off yet. */
export const selectPendingApproval = (state: AgentsState) =>
  state.jobs.filter((job) => job.state === 'awaiting_approval')

export const selectDesk = (state: AgentsState) => state.agents.find((agent) => agent.frontDesk)

/**
 * Derived, never stored: a second copy of the policy could drift away from the
 * ladder the bridge actually enforces.
 */
export const selectApprovalRequired = (state: AgentsState) => state.autoRank !== 'sergeant'

/** Seconds from ask to pick-up, newest first. */
export const selectAckLatencies = (state: AgentsState) =>
  state.tickets
    .filter((ticket) => ticket.ackAt !== null)
    .map((ticket) => ((ticket.ackAt as number) - ticket.createdAt) / 1000)

export const median = (values: number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export const formatSeconds = (seconds: number | null) =>
  seconds === null ? '--' : seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
export type AppDispatch = typeof store.dispatch

export const requestRun = () => runRequested

export { rootSaga }
