// Dispatch smoke test for the agents slice + runPiAgent saga.
// Run: node test/dispatch.test.mjs
//
// Stubs the browser-only globals the saga uses (EventSource, fetch), then
// dispatches requestRun() and drives fake Pi RPC events through the channel.

const sent = { sse: null, prompts: [] }

class FakeEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static all = []
  constructor(url) {
    sent.sse = url
    FakeEventSource.instance = this
    FakeEventSource.all.push(this)
    this.readyState = FakeEventSource.OPEN
    this.closed = false
  }
  // Real SSE fans every frame out to every subscriber: the persistent watcher
  // and the current run each receive their own copy. Nothing arrives after close.
  emit(event) { for (const other of FakeEventSource.all) if (!other.closed) other.onmessage?.({ data: JSON.stringify(event) }) }
  // Simulate the browser dropping the stream for good.
  drop() { this.readyState = FakeEventSource.CLOSED; this.onerror?.({}) }
  // Simulate a transient blip — EventSource is still reconnecting.
  blip() { this.readyState = FakeEventSource.CONNECTING; this.onerror?.({}) }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED }
}
globalThis.EventSource = FakeEventSource

globalThis.fetch = async (url, options) => {
  sent.prompts.push({ url, message: JSON.parse(options.body).message })
  return { ok: true, status: 202, json: async () => ({ accepted: true }) }
}

const { store, requestRun } = await import('../src/store.ts')

// If the saga was never started, no event channel is ever created and
// rootSaga stays unreferenced by the middleware. Detect that directly.
const sagaIsRunning = () => FakeEventSource.instance !== undefined

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const settle = () => new Promise((r) => setTimeout(r, 30))

// ---------------------------------------------------------------- scenario 1
console.log('\n[1] dispatch(requestRun()) starts the saga pipeline\n')
const before = store.getState().agents
store.dispatch(requestRun())
await settle()
const after = store.getState().agents

check('saga consumed agents/runRequested', sagaIsRunning(),
  sagaIsRunning() ? 'event channel created' : 'no EventSource/fetch — action had no listeners')
check('runNumber incremented by startRun', after.runNumber === before.runNumber + 1,
  `${before.runNumber} -> ${after.runNumber}`)
check('POST /api/prompt issued', sent.prompts.length === 1,
  JSON.stringify(sent.prompts[0] ?? null))

// ---------------------------------------------------------------- scenario 2
console.log('\n[2] Pi RPC events stream into the timeline\n')
if (sagaIsRunning()) {
  const source = FakeEventSource.instance
  const n0 = store.getState().agents.events.length
  source.emit({ type: 'agent_start' })
  await settle()
  check('agent_start -> timeline event', store.getState().agents.events.length === n0 + 1)
  check('agent_start -> orchestrator working',
    store.getState().agents.agents.find((a) => a.id === 'orchestrator').status === 'working')

  const n1 = store.getState().agents.events.length
  source.emit({ type: 'tool_execution_start', toolName: 'bash' })
  await settle()
  check('tool_execution_start -> builder working',
    store.getState().agents.agents.find((a) => a.id === 'builder').status === 'working' &&
    store.getState().agents.events.length === n1 + 1)

  const n2 = store.getState().agents.events.length
  source.emit({ type: 'agent_end' })
  await settle()
  check('agent_end -> orchestrator done',
    store.getState().agents.agents.find((a) => a.id === 'orchestrator').status === 'done')
  check('agent_end closes the event channel', source.closed === true, `closed=${source.closed}`)
  check('timeline unchanged after saga exits',
    store.getState().agents.events.length === n2 + 1)
} else {
  check('event stream handling', false, 'skipped — saga never started')
}

// ---------------------------------------------------------------- scenario 3
console.log('\n[3] tool results and transient reconnects\n')
if (sagaIsRunning()) {
  store.dispatch(requestRun())
  await settle()
  const source = FakeEventSource.instance
  const agent = (id) => store.getState().agents.agents.find((a) => a.id === id)

  source.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash' })
  await settle()
  check('tool start -> builder working', agent('builder').status === 'working')

  source.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false })
  await settle()
  check('tool ok -> builder back to standby', agent('builder').status === 'waiting', agent('builder').task)

  source.emit({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'edit' })
  source.emit({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'edit', isError: true })
  await settle()
  check('tool error -> builder fault status', agent('builder').status === 'error', agent('builder').task)
  check('tool error -> error-kind timeline entry',
    store.getState().agents.events[0].kind === 'error', store.getState().agents.events[0].action)

  const before = store.getState().agents.events.length
  source.blip()
  await settle()
  check('transient reconnect is ignored',
    store.getState().agents.events.length === before && agent('orchestrator').status !== 'error')

  source.emit({ type: 'bridge_error', errorMessage: 'Pi returned invalid JSON' })
  await settle()
  check('bridge_error logged, run continues',
    store.getState().agents.events.length === before + 1 && agent('orchestrator').status === 'working')

  source.emit({ type: 'agent_end', willRetry: true })
  await settle()
  check('agent_end + willRetry keeps the run alive',
    store.getState().agents.events[0].action === 'Retrying' && !source.closed)

  source.emit({ type: 'agent_settled' })
  await settle()
  check('agent_settled closes the run', source.closed === true && agent('orchestrator').status === 'done')
}

// ---------------------------------------------------------------- scenario 4
console.log('\n[4] hard disconnect surfaces instead of freezing\n')
if (sagaIsRunning()) {
  store.dispatch(requestRun())
  await settle()
  const source = FakeEventSource.instance
  source.emit({ type: 'agent_start' })
  await settle()
  source.drop()
  await settle()
  const agent = (id) => store.getState().agents.agents.find((a) => a.id === id)
  check('SSE CLOSED -> orchestrator error status', agent('orchestrator').status === 'error', agent('orchestrator').task)
  check('SSE CLOSED -> connection-lost timeline entry',
    store.getState().agents.events[0].kind === 'error' && store.getState().agents.events[0].action === 'Connection lost',
    store.getState().agents.events[0].detail)
  check('SSE CLOSED -> channel closed', source.closed === true)

  store.dispatch(requestRun())
  await settle()
  const next = FakeEventSource.instance
  next.emit({ type: 'bridge_closed', detail: 'Pi exited with code 1' })
  await settle()
  check('bridge_closed -> orchestrator error status',
    agent('orchestrator').status === 'error' && store.getState().agents.events[0].action === 'Connection lost',
    store.getState().agents.events[0].detail)
  check('bridge_closed -> channel closed', next.closed === true)
}

// ---------------------------------------------------------------- scenario 5
console.log('\n[5] rejected prompt degrades gracefully\n')
{
  const agent = (id) => store.getState().agents.agents.find((a) => a.id === id)
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ accepted: false, error: 'A prompt message is required' }) })
  store.dispatch(requestRun())
  await settle()
  check('bridge 400 -> orchestrator error status', agent('orchestrator').status === 'error', agent('orchestrator').task)
  check('bridge 400 -> reason is visible',
    store.getState().agents.events[0].detail.includes('A prompt message is required'),
    store.getState().agents.events[0].detail)

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  store.dispatch(requestRun())
  await settle()
  check('network down -> error status, saga still alive', agent('orchestrator').status === 'error')
  globalThis.fetch = async (url, options) => {
    sent.prompts.push({ url, message: JSON.parse(options.body).message })
    return { ok: true, status: 202, json: async () => ({ accepted: true }) }
  }
}


// ---------------------------------------------------------------- scenario 6
console.log('\n[6] bridge stderr, timeline cap, and Clear\n')
{
  const { clearTimeline } = await import('../src/store.ts')
  store.dispatch(requestRun())
  await settle()
  const source = FakeEventSource.instance
  const agent = (id) => store.getState().agents.agents.find((a) => a.id === id)

  source.emit({ type: 'bridge_log', detail: 'pi: tool stderr' })
  await settle()
  check('bridge_log reaches the timeline', store.getState().agents.events[0].kind === 'log', store.getState().agents.events[0].detail)
  check('bridge_log does not fault the run', agent('orchestrator').status !== 'error')

  source.emit({ type: 'bridge_log', detail: '' })
  await settle()
  check('empty bridge_log is dropped', store.getState().agents.events[0].detail === 'pi: tool stderr')

  for (let i = 0; i < 80; i++) source.emit({ type: 'agent_start' })
  await settle()
  check('timeline is capped at 60 events', store.getState().agents.events.length === 60, `got ${store.getState().agents.events.length}`)
  check('newest events kept', store.getState().agents.events[0].action === 'Started')
  check('event ids stay unique', new Set(store.getState().agents.events.map((e) => e.id)).size === 60)

  store.dispatch(clearTimeline())
  check('clearTimeline empties the stream', store.getState().agents.events.length === 0)
  check('clearTimeline records the time', /^\d{1,2}:\d{2}:\d{2}/.test(String(store.getState().agents.clearedAt)), String(store.getState().agents.clearedAt))

  source.emit({ type: 'agent_start' })
  await settle()
  check('events resume after clear', store.getState().agents.events.length === 1 && store.getState().agents.events[0].action === 'Started')

  globalThis.fetch = async () => ({ ok: true, status: 202, json: async () => ({ accepted: true }) })
}

// ---------------------------------------------------------------- scenario 7
console.log('\n[7] no agent is left working after a run ends\n')
{
  const agent = (id) => store.getState().agents.agents.find((a) => a.id === id)
  store.dispatch(requestRun())
  await settle()
  const source = FakeEventSource.instance

  source.emit({ type: 'bridge_log', detail: 'pi: stderr' })
  source.emit({ type: 'tool_execution_start', toolCallId: 'c9', toolName: 'read' })
  await settle()
  check('log + tool put workers into working',
    agent('researcher').status === 'working' && agent('builder').status === 'working')

  source.emit({ type: 'agent_end' })
  await settle()
  check('agent_end resets researcher to standby', agent('researcher').status === 'waiting', agent('researcher').task)
  check('agent_end resets builder to standby', agent('builder').status === 'waiting', agent('builder').task)
  check('agent_end leaves orchestrator done', agent('orchestrator').status === 'done')

  store.dispatch(requestRun())
  await settle()
  const second = FakeEventSource.instance
  second.emit({ type: 'tool_execution_start', toolCallId: 'c10', toolName: 'bash' })
  second.emit({ type: 'tool_execution_end', toolCallId: 'c10', toolName: 'bash', isError: true })
  await settle()
  check('tool failure marks builder error', agent('builder').status === 'error')

  second.drop()
  await settle()
  check('disconnect keeps a builder fault visible', agent('builder').status === 'error', agent('builder').task)
  check('disconnect faults orchestrator', agent('orchestrator').status === 'error')
}

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failing: ' + failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
