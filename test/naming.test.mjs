// Naming agents: localStorage restore, rename/add/remove, and the rule that a
// timeline entry keeps the name the agent had at the time.
// Run: node test/naming.test.mjs

const streams = []

// The store subscribes to the bridge as soon as it is imported, so even the
// reducer-only suite needs an EventSource to exist.
class FakeEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  constructor(url) {
    this.url = url
    this.readyState = FakeEventSource.OPEN
    this.closed = false
    streams.push(this)
  }
  close() { this.closed = true }
}
globalThis.EventSource = FakeEventSource

const store = new Map()
store.set('pi-agents/control-room', JSON.stringify({
  version: 1,
  agents: [
    { id: 'orchestrator', name: 'Orchestrator', role: 'Lead agent', accent: 'coral' },
    { id: 'builder', name: 'Forge', role: 'Implementation', accent: 'blue' },
    { id: 'custom-3', name: 'Reviewer', role: 'Code review', accent: 'coral', custom: true },
  ],
}))
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, value),
  removeItem: (key) => store.delete(key),
}

const { store: redux, renameAgent, addAgent, removeAgent, agentStep, startRun } = await import('../src/store.ts')

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const agents = () => redux.getState().agents.agents
const agent = (id) => agents().find((a) => a.id === id)
const byName = (name) => agents().find((a) => a.name === name)
const events = () => redux.getState().agents.events
const snapshot = () => JSON.parse(store.get('pi-agents/control-room'))

console.log('\n[A] persisted roster is replayed at import\n')
check('the bridge watcher is live before any dispatch', streams.length === 1 && streams[0].url === '/api/events', `${streams.length} streams`)
check('the desk is manned by the restored roster', agents().some((item) => item.frontDesk))
check('renamed built-in comes back', agent('builder').name === 'Forge', agent('builder').name)
check('untouched built-in keeps its seed name', agent('orchestrator').name === 'Orchestrator')
check('custom agent is restored', !!byName('Reviewer') && byName('Reviewer').custom === true)
check('restored custom agent keeps its id', byName('Reviewer')?.id === 'custom-3', byName('Reviewer')?.id)
check('restored agents start on standby', byName('Reviewer')?.status === 'waiting')
check('roster has 4 agents', agents().length === 4, String(agents().length))

console.log('\n[B] add / rename / remove\n')
redux.dispatch(addAgent({ name: 'Tester', role: 'QA' }))
const tester = byName('Tester')
check('addAgent appends a custom agent', !!tester && tester.custom === true && tester.id === 'custom-4', tester?.id)
check('id counter skips the restored custom-3', tester?.id === 'custom-4', tester?.id)
check('new agent starts on standby', tester?.status === 'waiting' && tester?.task === 'Ready for assignment')
redux.dispatch(addAgent({ name: 'Silent' }))
check('role falls back when omitted', byName('Silent').role === 'Custom agent', byName('Silent').role)

redux.dispatch(addAgent({ name: 'tester' }))
check('case-insensitive duplicate name is rejected', !byName('tester') && agents().filter((a) => a.name === 'Tester').length === 1)
redux.dispatch(addAgent({ name: '   ' }))
check('blank name is rejected', agents().length === 6, String(agents().length))

redux.dispatch(renameAgent({ id: tester.id, name: 'QA Bot' }))
check('renameAgent updates the name', byName('QA Bot')?.id === 'custom-4', byName('QA Bot')?.id)
redux.dispatch(renameAgent({ id: tester.id, name: '  ' }))
check('blank rename is ignored', byName('QA Bot') !== undefined)
redux.dispatch(renameAgent({ id: tester.id, name: 'Reviewer' }))
check('rename onto an existing name is rejected', byName('QA Bot') !== undefined && byName('Reviewer') !== undefined)
redux.dispatch(renameAgent({ id: 'nope', name: 'Ghost' }))
check('rename of an unknown id is a no-op', !byName('Ghost'))

redux.dispatch(removeAgent({ id: 'orchestrator' }))
check('built-in agents cannot be removed', !!agent('orchestrator'))
redux.dispatch(removeAgent({ id: 'researcher' }))
check('seed roles survive removal attempts', !!agent('researcher'))
redux.dispatch(removeAgent({ id: tester.id }))
check('custom agent can be removed', !byName('QA Bot') && agents().length === 5, String(agents().length))

console.log('\n[C] names reach the dashboard timeline\n')
redux.dispatch(agentStep({ agentId: 'builder', status: 'working', task: 'Running bash', event: { action: 'Tool call', detail: 'bash', kind: 'tool' } }))
check('entry uses the renamed agent', events()[0].agent === 'Forge', events()[0].agent)
redux.dispatch(renameAgent({ id: 'builder', name: 'Smith' }))
redux.dispatch(agentStep({ agentId: 'builder', status: 'working', task: 'Running edit', event: { action: 'Tool call', detail: 'edit', kind: 'tool' } }))
check('new entry uses the new name', events()[0].agent === 'Smith', events()[0].agent)
check('older entry keeps the name it had', events()[1].agent === 'Forge', events()[1].agent)
redux.dispatch(startRun())
check('startRun renames nobody and resets the roster', byName('Smith') !== undefined && agent('builder').status === 'waiting')

console.log('\n[D] persistence hygiene\n')
check('roster snapshot is written', snapshot().version === 1)
check('renames are persisted', JSON.stringify(snapshot().agents).includes('Smith'))
check('live status is not persisted', !('status' in snapshot().agents[0]), Object.keys(snapshot().agents[0]).join(','))
check('task is not persisted', !('task' in snapshot().agents[0]))
check('removed agent is gone from storage', !JSON.stringify(snapshot().agents).includes('QA Bot'))
check('accent is always a known value', snapshot().agents.every((a) => ['coral', 'mint', 'blue'].includes(a.accent)))

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failing: ' + failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
