// Redux-saga semantics for the agents store: reducer purity, watcher pattern
// binding, and takeLatest cancellation. Run: node test/saga-semantics.test.mjs

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
  // Faithful to the real API: nothing arrives once close() has been called.
  emit(event) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(event) }) }
  drop() { this.readyState = FakeEventSource.CLOSED; this.onerror?.({}) }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED }
}
globalThis.EventSource = FakeEventSource

let promptCount = 0
globalThis.fetch = async () => {
  promptCount += 1
  return { ok: true, status: 202, json: async () => ({ accepted: true }) }
}

const { store, requestRun, startRun, agentStep, endRun, clearTimeline, addAgent, removeAgent } = await import('../src/store.ts')

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const settle = () => new Promise((r) => setTimeout(r, 30))
const section = (title) => console.log(`\n${title}\n`)
const agents = () => store.getState().agents.agents
const agent = (id) => agents().find((a) => a.id === id)
const events = () => store.getState().agents.events

// ------------------------------------------------------------------ reducers
section('[A] slice reducers in isolation (no saga involved)')

const descending = (list) => list.every((e, i) => i === 0 || list[i - 1].id > e.id)
check('seeded timeline is already newest-first', descending(events()), events().map((e) => e.id).join(','))

store.dispatch(startRun())
check('startRun bumps runNumber', store.getState().agents.runNumber === 13, String(store.getState().agents.runNumber))
check('startRun leaves only the orchestrator working',
  agent('orchestrator').status === 'working' &&
  agent('builder').status === 'waiting' && agent('researcher').status === 'waiting')

store.dispatch(agentStep({ agentId: 'builder', status: 'working', task: 'Running bash', event: { action: 'Tool', detail: 'd', kind: 'tool' } }))
check('agentStep updates the matched agent', agent('builder').status === 'working' && agent('builder').task === 'Running bash')
check('agentStep prepends the timeline entry', events()[0].action === 'Tool')
check('timeline entry carries the resolved display name', events()[0].agent === 'Builder', events()[0].agent)

const countBefore = events().length
store.dispatch(agentStep({ agentId: 'ghost', status: 'working', task: 'nope', event: { action: 'Orphan', detail: 'd', kind: 'tool' } }))
check('unknown agentId logs the event without throwing',
  events().length === countBefore + 1 && agents().every((a) => a.name !== 'ghost'))
check('unknown agentId falls back to the raw id in the timeline', events()[0].agent === 'ghost', events()[0].agent)

check('timeline stays newest-first after prepends', descending(events()), events().slice(0, 4).map((e) => e.id).join(','))

store.dispatch(endRun())
check('endRun releases a working worker', agent('builder').status === 'waiting', agent('builder').task)
check('endRun does not speak for the orchestrator', agent('orchestrator').status === 'working')

store.dispatch(agentStep({ agentId: 'builder', status: 'error', task: 'edit returned an error', event: { action: 'Tool failed', detail: 'd', kind: 'error' } }))
store.dispatch(endRun())
check('endRun preserves an explicit fault', agent('builder').status === 'error', agent('builder').task)

store.dispatch(addAgent({ name: 'Provisional' }))
const added = agents().at(-1)
check('with no saved roster the first custom id is custom-1',
  added.id === 'custom-1' && added.name === 'Provisional' && added.custom === true && agents().length === 4,
  `${added.id} / ${agents().length} agents`)
store.dispatch(removeAgent({ id: 'custom-1' }))
check('the added agent is removable again', !agents().some((a) => a.id === 'custom-1'))

store.dispatch(clearTimeline())
check('clearTimeline empties events', events().length === 0)
check('clearTimeline stamps clearedAt', !!store.getState().agents.clearedAt, String(store.getState().agents.clearedAt))
check('clearTimeline leaves agents untouched', agent('builder').status === 'error')

// ------------------------------------------------------------------- watcher
section('[B] watcher binding on agents/runRequested')

const sourcesBefore = sources.length
store.dispatch({ type: 'agents/runRequestedTypo' })
store.dispatch({ type: 'other/runRequested' })
await settle()
check('near-miss action types start nothing', sources.length === sourcesBefore, `${sources.length - sourcesBefore} new sources`)
check('near-miss actions leave runNumber alone', store.getState().agents.runNumber === 13)

store.dispatch(requestRun())
await settle()
check('agents/runRequested starts exactly one run', sources.length === sourcesBefore + 1)
check('run subscribes to the bridge stream', sources[sources.length - 1].url === '/api/events')
check('run POSTs the prompt once', promptCount === 1, `prompts=${promptCount}`)

const first = sources[sources.length - 1]
first.emit({ type: 'agent_start' })
await settle()
check('first run drives state', agent('orchestrator').status === 'working' && events()[0].action === 'Started')

// ------------------------------------------------------------- takeLatest
section('[C] takeLatest cancellation semantics')

store.dispatch(requestRun())
await settle()
const second = sources[sources.length - 1]
check('re-dispatch opens a second event stream', second !== first && second.closed === false)
check('re-dispatch closes the first stream (finally ran)', first.closed === true)
check('each run POSTs its own prompt', promptCount === 2, `prompts=${promptCount}`)

const eventsAfterCancel = events().length
const stateBefore = store.getState().agents
// Bypass the fake's post-close guard and drive the handler directly, the way a
// misbehaving stream would after cancellation.
first.onmessage({ data: JSON.stringify({ type: 'agent_settled' }) })
first.onmessage({ data: JSON.stringify({ type: 'tool_execution_start', toolName: 'edit' }) })
await settle()
check('cancelled run leaks no timeline entries', events().length === eventsAfterCancel,
  `${events().length - eventsAfterCancel} leaked events`)
check('cancelled run cannot mutate agents',
  store.getState().agents === stateBefore && agent('builder').status === 'waiting')

second.emit({ type: 'agent_start' })
await settle()
check('surviving run still drives state', events()[0].action === 'Started')

second.emit({ type: 'tool_execution_start', toolCallId: 'z', toolName: 'bash' })
await settle()
check('worker goes working on the live run', agent('builder').status === 'working')
second.emit({ type: 'agent_end' })
await settle()
check('agent_end settles orchestrator', agent('orchestrator').status === 'done')
check('agent_end releases the worker', agent('builder').status === 'waiting')
check('settled run closes its own stream', second.closed === true)

const idleEvents = events().length
await settle()
check('no stray ticks after the run completes', events().length === idleEvents)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failing: ' + failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
