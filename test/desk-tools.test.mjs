// The desk extension's tools, driven against a mock pi and a stub bridge.
// Proves the room's rule: crew can escalate, only the desk can ask the user.
// Run: node test/desk-tools.test.mjs
import http from 'node:http'

const received = []
const stubBridge = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    received.push({ path: request.url, body: JSON.parse(body || '{}') })
    // Echo the gate decision so the tool's branch can be asserted.
    const held = request.url === '/api/dispatch' && JSON.parse(body || '{}').requiresApproval !== false
    const rank = JSON.parse(body || '{}').rank
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ accepted: true, to: 'local:crew', awaitingApproval: held, rank, confirmations: rank === 'sergeant' ? 2 : 1 }))
  })
})
await new Promise((resolve) => stubBridge.listen(0, '127.0.0.1', resolve))
const bridgeUrl = `http://127.0.0.1:${stubBridge.address().port}`

process.env.PI_BRIDGE_URL = bridgeUrl

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Load the extension as a given squad member. */
async function loadAs(role) {
  const tools = new Map()
  const commands = new Map()
  process.env.PI_ROLE = role
  process.env.PI_PROJECT = 'nypd'
  process.env.PI_FRONT_DESK = role === 'desk' ? '1' : '0'
  const write = process.stderr.write.bind(process.stderr)
  let report = ''
  process.stderr.write = (chunk) => { report += chunk; return true }
  const module = await import(new URL(`../.pi/extensions/agent-desk.ts?role=${role}&bridge=${encodeURIComponent(process.env.PI_BRIDGE_URL)}`, import.meta.url).href)
  module.default({
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: (name, options) => commands.set(name, options),
  })
  process.stderr.write = write
  return { tools, commands, report }
}

console.log('[A] the desk member\n')
const desk = await loadAs('desk')
check('registers a status command', desk.commands.has('desk-status'), [...desk.commands.keys()].join(','))
check('can hand work to the crew', desk.tools.has('dispatch_job'))
check('can put the wait on the user', desk.tools.has('ask_user'))
check('does not register the crew-only escape hatch', !desk.tools.has('escalate_to_desk'))
check('every tool advertises itself in the prompt', [...desk.tools.values()].every((tool) => typeof tool.promptSnippet === 'string' && tool.promptSnippet.length > 0))
check('the desk self-reports the tools it registered',
  desk.report.includes('(desk)') && desk.report.includes('tools=dispatch_job,ask_user'), desk.report.trim())
// pi's docs require each guideline bullet to name its own tool, because
// guidelines are flattened into one global list with no grouping.
check('every guideline names its own tool', [...desk.tools.values()].every((tool) => (tool.promptGuidelines ?? []).every((line) => line.includes(tool.name))), [...desk.tools.values()].flatMap((tool) => tool.promptGuidelines ?? []).find((line) => !line.includes('dispatch_job') && !line.includes('ask_user')))

received.length = 0
const asked = await desk.tools.get('ask_user').execute('tc-1', { question: '旧数据还是重跑基线?', ticketId: 12 })
check('ask_user posts to /api/ask', received.length === 1 && received[0].path === '/api/ask', JSON.stringify(received[0]?.path))
check('ask_user carries the bridge identity', received[0]?.body?.project === 'nypd' && received[0]?.body?.role === 'desk', JSON.stringify(received[0]?.body))
check('ask_user carries the question', received[0]?.body?.question?.includes('重跑基线'))
check('ask_user tells the model to stop and wait', /waiting on them/.test(asked.content[0].text), asked.content[0].text)

received.length = 0
const dispatched = await desk.tools.get('dispatch_job').execute('tc-2', { job: 're-run the sweep', role: 'crew', ticketId: 12 })
check('dispatch_job posts to /api/dispatch', received[0]?.path === '/api/dispatch')
check('dispatch_job forwards the target role', received[0]?.body?.targetRole === 'crew', JSON.stringify(received[0]?.body))
check('dispatch_job names the ticket it answers', received[0]?.body?.ticketId === 12)
check('dispatch tells the desk to speak for the crew', /Tell the user/.test(dispatched.content[0].text))
check('a held job is described as waiting for a signature',
  /Queued for approval/.test(dispatched.content[0].text), dispatched.content[0].text)

received.length = 0
const waived = await desk.tools.get('dispatch_job').execute('tc-2b', { job: '只看一眼日志', requiresApproval: false })
check('the desk can waive the gate for read-only work', received[0]?.body?.requiresApproval === false)
check('a waived job is reported as already sent', /The crew has the job/.test(waived.content[0].text), waived.content[0].text)

received.length = 0
const ranked = await desk.tools.get('dispatch_job').execute('tc-2c', { job: '清掉旧结果', rank: 'sergeant' })
check('the rank travels to the bridge', received[0]?.body?.rank === 'sergeant', JSON.stringify(received[0]?.body?.rank))
check('a two-click rank is explained to the model', /confirm it 2 times/.test(ranked.content[0].text), ranked.content[0].text)

received.length = 0
await desk.tools.get('dispatch_job').execute('tc-2d', { job: '无 rank' })
check('omitting the rank sends nothing extra', received[0]?.body?.rank === undefined, JSON.stringify(received[0]?.body))

console.log('\n[B] a field member\n')
const field = await loadAs('crew')
check('can escalate', field.tools.has('escalate_to_desk'))
check('cannot dispatch work', !field.tools.has('dispatch_job'))
check('cannot ask the user directly', !field.tools.has('ask_user'), [...field.tools.keys()].join(','))
check('still exposes the status command', field.commands.has('desk-status'))
check('a field member reports only its escape hatch',
  field.report.includes('(field)') && field.report.includes('tools=escalate_to_desk'), field.report.trim())

received.length = 0
const escalated = await field.tools.get('escalate_to_desk').execute('tc-3', { question: 'which checkpoint?', blocking: true })
check('escalate posts to /api/escalate', received[0]?.path === '/api/escalate')
check('escalate says it is blocking', received[0]?.body?.blocking === true, JSON.stringify(received[0]?.body))
check('escalate is attributed to the field role', received[0]?.body?.role === 'crew' && received[0]?.body?.project === 'nypd')
check('a blocking escalation pauses the crew member', /paused/i.test(escalated.content[0].text), escalated.content[0].text)

received.length = 0
await field.tools.get('escalate_to_desk').execute('tc-4', { question: 'minor preference' })
check('non-blocking defaults to false', received[0]?.body?.blocking === false)
const carried = await field.tools.get('escalate_to_desk').execute('tc-5', { question: 'fyi' })
check('non-blocking keeps the crew working', /Carry on/.test(carried.content[0].text))

console.log('\n[C] a bridge that is not there\n')
process.env.PI_BRIDGE_URL = 'http://127.0.0.1:1'
const offline = await loadAs('desk')
check('the offline load really did re-read the bridge url', offline.tools.size === 2)
const failedTool = await offline.tools.get('ask_user').execute('tc-6', { question: 'anyone there?' })
check('unreachable bridge degrades to tool text', /Could not surface/.test(failedTool.content[0].text), failedTool.content[0].text)
check('and never throws into the session', failedTool.content[0].text.includes('bridge unreachable'))

const notified = []
await offline.commands.get('desk-status').handler({}, { ui: { notify: (line, level) => notified.push({ line, level }) } })
await new Promise((r) => setTimeout(r, 120))
check('status command reports the identity', notified.length === 1 && notified[0].line.includes('nypd:desk'), JSON.stringify(notified[0]))
check('and flags the bridge as unreachable', notified[0]?.level === 'error' && /unreachable/.test(notified[0]?.line ?? ''), JSON.stringify(notified[0]))

stubBridge.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('Failing: ' + failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
