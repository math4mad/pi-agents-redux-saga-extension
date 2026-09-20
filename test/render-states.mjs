// Renders <App /> in a fault state via Vite's SSR loader and checks the DOM
// the new store states are supposed to produce. No browser needed.
// Run: node test/render-states.mjs
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider } from 'react-redux'
import { createServer } from 'vite'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
// Captured so the check is about real behaviour, not about the absence of one.
const logged = []
const originalError = console.error
console.error = (...args) => { logged.push(args.map(String).join(' ')) }
try {
  const { store, agentStep, clearTimeline, renameAgent, addAgent, submitUserMessage, autoAck, deskSays, jobProposed, decideJob, assignSquad } = await server.ssrLoadModule('/src/store.ts')
  check('importing the store in node logs no saga crash',
    !logged.some((line) => /EventSource is not defined/.test(line)), logged.find((line) => /EventSource/.test(line)) ?? 'clean')
  const { default: App } = await server.ssrLoadModule('/src/App.tsx')

  const nominalHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))

  store.dispatch(agentStep({
    agentId: 'orchestrator',
    status: 'error',
    task: 'Connection to Pi lost',
    event: { action: 'Connection lost', detail: 'Live stream to the Pi bridge closed', kind: 'error' },
  }))

  const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))
  const checks = [
    ['nominal: header pill says Live session', nominalHtml.includes('Live session') && !nominalHtml.includes('fault')],
    ['nominal: footer says the desk is manned', nominalHtml.includes('DESK MANNED') && !nominalHtml.includes('BRIDGE FAULT')],
    ['nominal: no error status classes', !nominalHtml.includes('status error') && !nominalHtml.includes('event-icon error')],
    ['agent card shows Fault label', />Fault</.test(html)],
    ['agent card carries status error', html.includes('status error')],
    ['status orb carries error class', html.includes('status-orb error')],
    ['timeline icon carries error class', html.includes('event-icon error')],
    ['timeline icon glyph is !', html.includes('>/<!') || html.includes('>!</div>')],
    ['header pill switches to Bridge lost', html.includes('Bridge lost')],
    ['live pill carries fault class', html.includes('live-pill fault')],
    ['footer reports bridge fault', html.includes('BRIDGE FAULT')],
    ['task line shows the lost connection', html.includes('Connection to Pi lost')],
    ['nominal label is gone', !html.includes('SYSTEM NOMINAL')],
  ]

  store.dispatch(agentStep({
    agentId: 'researcher',
    status: 'working',
    task: 'Watching the Pi bridge log',
    event: { action: 'Bridge log', detail: 'pi: stderr line', kind: 'log' },
  }))
  const logHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))

  store.dispatch(clearTimeline())
  const clearedHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))

  checks.push(
    ['log: timeline icon carries log class', logHtml.includes('event-icon log')],
    ['log: icon glyph is \u00bb', logHtml.includes('>\u00bb</div>') || logHtml.includes('\u00bb')],
    ['log: stderr detail is rendered', logHtml.includes('pi: stderr line')],
    ['clear: Clear button is rendered', /class="quiet-button"[^>]*>Clear activity</.test(clearedHtml)],
    ['clear: empty state replaces the stream', clearedHtml.includes('timeline-empty')],
    ['clear: empty state reports when', /Activity cleared at \d{1,2}:\d{2}:\d{2}/.test(clearedHtml)],
    ['clear: no stale events remain', !clearedHtml.includes('pi: stderr line')],
    // Clear is history-only: live agent state survives it by design.
    ['clear: agent status survives the clear', clearedHtml.includes('status error') && clearedHtml.includes('Connection to Pi lost')],
  )

  store.dispatch(addAgent({ name: 'Reviewer', role: 'Code review' }))
  store.dispatch(renameAgent({ id: 'builder', name: 'Forge' }))
  store.dispatch(agentStep({ agentId: 'builder', status: 'working', task: 'Running bash', event: { action: 'Tool call', detail: 'bash', kind: 'tool' } }))
  const namedHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))

  checks.push(
    ['names: every operator row is an editable input', (namedHtml.match(/agent-name-input/g) ?? []).length === 4],
    ['names: seed names render', namedHtml.includes('value="Orchestrator"') && namedHtml.includes('value="Researcher"')],
    ['names: a rename is displayed', namedHtml.includes('value="Forge"') && !namedHtml.includes('value="Builder"')],
    ['names: an added agent is displayed', namedHtml.includes('value="Reviewer"') && namedHtml.includes('Code review')],
    ['names: timeline row shows who acted', /class="event-agent">Forge</.test(namedHtml)],
    ['names: added agent exposes a remove control', namedHtml.includes('aria-label="Remove Reviewer"')],
    ['names: built-in roles have no remove control', !namedHtml.includes('Remove Orchestrator') && !namedHtml.includes('Remove Forge')],
    ['names: submit is disabled while the name is empty', /add-agent-button[^>]*disabled=""/.test(namedHtml)],
  )

  store.dispatch(submitUserMessage({ text: '中途加一个想法: 也测 seed 43' }))
  const ticketId = store.getState().agents.tickets[0].id
  store.dispatch(autoAck({ ticketId }))
  store.dispatch(deskSays({ text: '要沿用旧数据还是重跑基线?', kind: 'question', ticketId }))
  const lineHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))

  store.dispatch(jobProposed({ id: 'job-r', brief: '重跑 5 seeds 的 sweep', target: 'nypd:field', requestedBy: 'nypd:desk', ticketId: 3 }))
  const gateHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))
  store.dispatch(decideJob({ id: 'job-r', approved: false, reason: '不要动 main' }))
  const declinedHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))

  checks.push(
    ['gate: an empty queue renders no card', !nominalHtml.includes('approval-card')],
    ['gate: a proposed job shows its brief', gateHtml.includes('approval-card') && gateHtml.includes('重跑 5 seeds 的 sweep')],
    ['gate: it says who would do it and for whom', gateHtml.includes('nypd:field') && gateHtml.includes('request #3')],
    ['gate: both decisions are offered', /class="approve-button"/.test(gateHtml) && /class="decline-button"/.test(gateHtml)],
    ['gate: a reason can be given', gateHtml.includes('approval-reason')],
    ['gate: the metric counts what awaits a signature', gateHtml.includes('Needs approval</span><strong>1</strong>')],
    ['gate: the card is styled as a hold, not progress', gateHtml.includes('approval-queue')],
    ['gate: deciding removes it from the queue', !declinedHtml.includes('approval-card')],
    ['gate: and the metric falls back to zero', declinedHtml.includes('Needs approval</span><strong>0</strong>')],
  )

  store.dispatch(jobProposed({ id: 'job-s', brief: '清空 results 目录', target: 'nypd:field', requestedBy: 'nypd:desk', rank: 'sergeant' }))
  const sergeantHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))
  store.dispatch(decideJob({ id: 'job-s', approved: true }))
  const halfwayHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))
  store.dispatch(jobProposed({ id: 'job-o', brief: '读一下日志', target: 'nypd:field', rank: 'officer', autoDispatch: true }))

  store.dispatch(jobProposed({ id: 'job-s3', brief: '删掉整张表', target: 'nypd:field', rank: 'sergeant' }))
  const mixedHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))

  checks.push(
    ['rank: the badge says which tier it is', sergeantHtml.includes('rank-badge sergeant') && /<span class="rank-badge sergeant">sergeant</.test(sergeantHtml)],
    ['rank: the card is marked as the dangerous tier', sergeantHtml.includes('approval-card sergeant')],
    ['rank: a job still owing two says Confirm, not Approve', sergeantHtml.includes('>Confirm<')],
    ['rank: the warning states how many are owed', sergeantHtml.includes('2 confirmations still required')],
    ['rank: one click in, the last step reads Approve',
      halfwayHtml.includes('>Approve<') && !halfwayHtml.includes('confirmations still required')],
    ['rank: ordinary work just says Approve', gateHtml.includes('>Approve<') && !gateHtml.includes('>Confirm<')],
    // One render, two tiers: the half-confirmed job is one click from running
    // and a fresh one still owes two, each saying so in its own copy.
    ['rank: tiers render side by side', (mixedHtml.match(/approval-card/g) ?? []).length === 2, `${(mixedHtml.match(/approval-card/g) ?? []).length} cards`],
    ['rank: both button copies appear together', />Confirm</.test(mixedHtml) && />Approve</.test(mixedHtml)],
    ['rank: the metric counts the gated jobs only', mixedHtml.includes('Needs approval</span><strong>2</strong>'), 'count off'],
    ['rank: work under the ladder never joins the queue', !mixedHtml.includes('approval-card officer') && !mixedHtml.includes('读一下日志')],
  )

  checks.push(
    ['line: empty state invites the first ask', nominalHtml.includes('conversation-empty')],
    ['line: the user turn is rendered', /chat-entry user/.test(lineHtml) && lineHtml.includes('seed 43')],
    ['line: the auto-ack echoes the ask', lineHtml.includes('is with the desk') && /chat-entry frontDesk auto-ack/.test(lineHtml)],
    ['line: the question is styled as waiting', /chat-entry frontDesk question/.test(lineHtml)],
    ['line: waiting-on-you is said out loud', lineHtml.includes('waiting for you')],
    ['line: the desk card carries its tag', lineHtml.includes('desk-tag')],
    ['line: composer is rendered', lineHtml.includes('composer-input') && lineHtml.includes('composer-send')],
    ['line: activity sits behind a disclosure', lineHtml.includes('<details class="activity"')],
    ['metrics: conversation labels replaced the process ones',
      lineHtml.includes('Unanswered') && lineHtml.includes('Waiting on you') && !lineHtml.includes('Active agents')],
    ['metrics: the fake latency tile is gone', !lineHtml.includes('1.84s')],
  )

  const policyHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))
  store.dispatch(assignSquad({
    project: "nypd",
    approvalRequired: false,
    roster: [
      { id: "nypd:desk", name: "Sgt. Miller", role: "Desk", frontDesk: true },
      { id: "nypd:field", name: "Det. Reyes", role: "Field" },
    ],
  }))
  const openHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(App)))

  checks.push(
    ["policy: the gate posture is stated on the panel", policyHtml.includes("until you approve it")],
    ["policy: a closed gate is not flagged as risky", !policyHtml.includes("gate-note open")],
    ["policy: the bridge can open the gate and the page says so",
      openHtml.includes("gate-note open") && openHtml.includes("The gate is off")],
    ["policy: an open gate still keeps one desk", openHtml.includes("Sgt. Miller") && openHtml.includes("Det. Reyes")],
  )
  for (const [name, pass] of checks) check(name, pass)
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} render checks passed`)
  if (failed.length) console.log('Failing: ' + failed.map((f) => f.name).join(', '))
} finally {
  console.error = originalError
  await server.close()
}
