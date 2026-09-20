import { useState, type FormEvent } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import type { Agent, AppDispatch, RootState } from './store'
import {
  requestRun, clearTimeline, renameAgent, addAgent, removeAgent,
  submitUserMessage, decideJob, selectUnanswered, selectInFlight, selectAwaitingUser, selectPendingApproval, selectApprovalRequired, selectAckLatencies, median, formatSeconds,
} from './store'
import './App.css'

const statusLabel = { working: 'Working', waiting: 'Standby', done: 'Complete', error: 'Fault' }

function App() {
  const dispatch = useDispatch<AppDispatch>()
  const slice = useSelector((state: RootState) => state.agents)
  const { agents, events, runNumber, clearedAt, squadError } = slice
  const approvalRequired = selectApprovalRequired(slice)
  const faulted = agents.some((agent) => agent.status === 'error')

  // Every number here is about the conversation, not about CPU activity.
  const unanswered = selectUnanswered(slice)
  const inFlight = selectInFlight(slice)
  const awaitingUser = selectAwaitingUser(slice)
  const pendingApproval = selectPendingApproval(slice)
  const ackLatency = formatSeconds(median(selectAckLatencies(slice)))

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark">π</div><div><p className="eyebrow">ORCHESTRA / DEVTOOLS</p><h1>Agent Control Room</h1></div></div>
        <div className="header-actions"><span className={`live-pill ${faulted ? 'fault' : ''}`}><span className="live-dot" /> {faulted ? 'Bridge lost' : 'Live session'}</span><a className="guide-link" href="/agent-control-room-guide.svg" target="_blank" rel="noreferrer">User guide <span>↗</span></a><button className="run-button" type="button" onClick={() => dispatch(requestRun())}><span>Demo run</span><span className="button-arrow">↗</span></button></div>
      </header>

      <section className="intro-row"><div><p className="kicker">{agents.find((agent) => agent.frontDesk)?.role ?? 'DESK'} / RUN {String(runNumber).padStart(2, '0')}</p><h2>Somebody always<br /><em>picks up.</em></h2></div><p className="intro-copy">The desk answers you the moment you ask. What the crew is doing underneath is a second question, and it lives below the fold.</p></section>
      <section className="metrics-strip" aria-label="Conversation state">
        <Metric label="Unanswered" value={String(unanswered.length)} detail="asked, no reply yet" tone={unanswered.length ? 'alert' : 'calm'} />
        <Metric label="First response" value={ackLatency} detail="median time to pick up" />
        <Metric label="Waiting on you" value={String(awaitingUser.length)} detail="the crew cannot move" tone={awaitingUser.length ? 'alert' : 'calm'} />
        <Metric label="Needs approval" value={String(pendingApproval.length)} detail="work nobody signed off" tone={pendingApproval.length ? 'alert' : 'calm'} />
        <Metric label="In flight" value={String(inFlight.length)} detail="acknowledged, still working" />
      </section>

      <div className="dashboard-grid">
        <section className="panel architecture-panel"><PanelHeading eyebrow="01 / Squad" title="Who is who" /><div className="flow-map">{['You, asking', 'The desk', 'The crew', 'Answer back'].map((label, index) => <div className="flow-node" key={label}><span className={`node-index ${index === 1 ? 'active' : ''}`}>0{index + 1}</span><strong>{label}</strong><small>{index === 0 ? 'ideas land any time' : index === 1 ? 'answers, triages, reports back' : index === 2 ? 'heads down on the work' : 'the desk speaks for them'}</small>{index < 3 && <span className="flow-line" aria-hidden="true">↓</span>}</div>)}</div><div className="architecture-note"><span className="pulse-ring" /> The crew never talks to you directly</div></section>
        <section className="panel conversation-panel">
          <PanelHeading eyebrow="02 / The line" title="Conversation" />
          {squadError && <p className="squad-error">{squadError}</p>}
          <ApprovalQueue />
          <ConversationList />
          <Composer />
          <p className={`gate-note ${approvalRequired ? '' : 'open'}`}>
            {approvalRequired
              ? 'Nothing the desk proposes reaches the crew until you approve it.'
              : 'The gate is off: the desk dispatches on its own.'}
          </p>
          <details className="activity">
            <summary>What the crew is doing <span className="activity-count">{events.length}</span></summary>
            <div className="timeline-list">{events.length === 0 ? <p className="timeline-empty">{clearedAt ? `Activity cleared at ${clearedAt}` : 'Nothing running yet'}</p> : events.map((event, index) => <article className="timeline-event" key={`${event.id}-${index}`}><div className={`event-icon ${event.kind}`} aria-hidden="true">{event.kind === 'receive' ? '↓' : event.kind === 'think' ? '◌' : event.kind === 'tool' ? '⌁' : event.kind === 'error' ? '!' : event.kind === 'log' ? '»' : '✓'}</div><div className="event-body"><div><strong>{event.action}</strong><span className="event-agent">{event.agent}</span></div><p>{event.detail}</p></div><time>{event.time}</time></article>)}</div>
            <button className="quiet-button" type="button" onClick={() => dispatch(clearTimeline())}>Clear activity</button>
          </details>
        </section>
        <section className="panel agents-panel"><PanelHeading eyebrow="03 / Roster" title="Operators" /><div className="agent-list">{agents.map((agent) => <AgentCard agent={agent} key={agent.id} />)}</div><AddAgentForm /><button className="text-button" type="button" onClick={() => dispatch(requestRun())}>Hand the next ticket to the desk <span>→</span></button></section>
      </div>
      <footer><span>PI AGENTS / REDUX-SAGA EXTENSION</span><span>BUILD 0.2.0 <i /> {faulted ? 'BRIDGE FAULT' : 'DESK MANNED'}</span></footer>
    </main>
  )
}

/**
 * The human gate. An agent asking for work is not the same as a human agreeing
 * to it, so proposed jobs stop here until somebody signs them off.
 */
function ApprovalQueue() {
  const dispatch = useDispatch<AppDispatch>()
  const jobs = useSelector((state: RootState) => state.agents.jobs)
    .filter((job) => job.state === 'awaiting_approval')
  const [reasons, setReasons] = useState<Record<string, string>>({})
  if (!jobs.length) return null

  return (
    <div className="approval-queue" role="group" aria-label="Jobs awaiting your approval">
      <p className="approval-heading">Proposed by the desk &middot; nobody has signed these off</p>
      {jobs.map((job) => (
        <article className={`approval-card ${job.rank}`} key={job.id}>
          <p className="approval-brief">{job.brief}</p>
          <small className="approval-meta">
            <span className={`rank-badge ${job.rank}`}>{job.rank}</span>
            {job.target}
            {job.ticketId !== null ? ` · request #${job.ticketId}` : ''}
          </small>
          <div className="approval-actions">
            <input
              className="approval-reason"
              aria-label={`Reason for declining ${job.id}`}
              placeholder="why not? (optional)"
              value={reasons[job.id] ?? ''}
              maxLength={200}
              onChange={(event) => setReasons((current) => ({ ...current, [job.id]: event.target.value }))}
            />
            <button className="approve-button" type="button" onClick={() => dispatch(decideJob({ id: job.id, approved: true }))}>
              {job.confirmations > 1 ? 'Confirm' : 'Approve'}
            </button>
            <button className="decline-button" type="button" onClick={() => dispatch(decideJob({ id: job.id, approved: false, reason: reasons[job.id] }))}>Decline</button>
          </div>
          {job.confirmations > 1 && (
            <p className="approval-warn">
              {job.rank} work can destroy things: {job.confirmations} confirmations still required before anything runs.
            </p>
          )}
        </article>
      ))}
    </div>
  )
}

function ConversationList() {
  const chat = useSelector((state: RootState) => state.agents.chat)
  if (!chat.length) {
    return <p className="conversation-empty">Nothing on the line. Ask for something, add an idea mid-run, or change your mind - the desk answers first and works second.</p>
  }
  return (
    <div className="conversation-list">
      {chat.map((entry) => (
        <article key={entry.id} className={`chat-entry ${entry.from} ${entry.kind}`}>
          <div className="chat-meta">
            <strong>{entry.from === 'user' ? 'You' : entry.kind === 'auto-ack' ? 'Desk (auto)' : 'Desk'}</strong>
            <time>{entry.time}</time>
          </div>
          <p>{entry.text}</p>
          {entry.needsInput && <span className="needs-input">waiting for you</span>}
        </article>
      ))}
    </div>
  )
}

function Composer() {
  const dispatch = useDispatch<AppDispatch>()
  const [text, setText] = useState('')
  const send = (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    dispatch(submitUserMessage({ text: value }))
    dispatch(requestRun())
    setText('')
  }
  return (
    <form className="composer" onSubmit={send}>
      <input className="composer-input" aria-label="Message the desk" placeholder="Tell the desk something..." value={text} maxLength={500} onChange={(event) => setText(event.target.value)} />
      <button className="composer-send" type="submit" disabled={!text.trim()}>Send</button>
    </form>
  )
}

function Metric({ label, value, detail, tone = 'calm' }: { label: string; value: string; detail: string; tone?: 'alert' | 'calm' }) {
  return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
}

function AgentCard({ agent }: { agent: Agent }) {
  const dispatch = useDispatch<AppDispatch>()
  const taken = useSelector((state: RootState) => state.agents.agents)
    .filter((item) => item.id !== agent.id)
    .map((item) => item.name.toLowerCase())
  const [name, setName] = useState(agent.name)
  const trimmed = name.trim()
  const clash = trimmed.length > 0 && trimmed !== agent.name && taken.includes(trimmed.toLowerCase())

  const commit = () => {
    if (!trimmed || clash) setName(agent.name)
    else dispatch(renameAgent({ id: agent.id, name: trimmed }))
  }

  return (
    <article className="agent-card">
      <div className={`agent-avatar ${agent.accent}`}>{agent.name.slice(0, 1).toUpperCase()}</div>
      <div className="agent-info">
        <div className="agent-name">
          <input
            aria-label={`Name for ${agent.role}`}
            className={`agent-name-input ${clash ? 'clash' : ''}`}
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') { setName(agent.name); event.currentTarget.blur() }
            }}
          />
          <span className={`status ${agent.status}`}>{agent.awaitingUser ? 'On you' : statusLabel[agent.status]}</span>
          {agent.frontDesk && <span className="desk-tag">Desk</span>}
        </div>
        <small>{agent.role}</small>
        <p>{agent.task}</p>
        {agent.awaitingUser && <span className="needs-input">the line is waiting on your reply</span>}
        {clash && <span className="agent-error">name already in use</span>}
      </div>
      {agent.custom && <button className="remove-agent" type="button" aria-label={`Remove ${agent.name}`} onClick={() => dispatch(removeAgent({ id: agent.id }))}>×</button>}
      <span className={`status-orb ${agent.status}`} />
    </article>
  )
}

function AddAgentForm() {
  const dispatch = useDispatch<AppDispatch>()
  // Select the stable array and derive here: a selector that maps returns a new
  // reference every call and trips the unstable-dependencies warning.
  const roster = useSelector((state: RootState) => state.agents.agents)
  const taken = roster.map((item) => item.name.toLowerCase())
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const trimmed = name.trim()
  const clash = trimmed.length > 0 && taken.includes(trimmed.toLowerCase())

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!trimmed || clash) return
    dispatch(addAgent({ name: trimmed, role: role.trim() }))
    setName('')
    setRole('')
  }

  return (
    <form className="add-agent" onSubmit={submit}>
      <input className="agent-input" aria-label="New agent name" placeholder="Add an operator…" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      <input className="agent-input role" aria-label="New agent role" placeholder="role" value={role} maxLength={40} onChange={(event) => setRole(event.target.value)} />
      <button className="add-agent-button" type="submit" disabled={!trimmed || clash}>Add</button>
      {clash && <small className="agent-error">name already in use</small>}
    </form>
  )
}
function PanelHeading({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) { return <div className="panel-heading"><div><p className="kicker">{eyebrow}</p><h3>{title}</h3></div>{action && <button className="quiet-button" type="button" onClick={onAction}>{action}</button>}</div> }

export default App
