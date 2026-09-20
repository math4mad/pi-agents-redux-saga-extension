# Testing this extension on another Mac

Three moving parts: the Vite app (`:5173`), the Pi RPC bridge (`server.cjs` on `:8787`),
and the pi extension (`.pi/extensions/dashboard.ts`, loaded by *pi*, not by Vite).

## 0. Copy the project without node_modules

There is no git repo here yet, so either initialise one or rsync:

```bash
# option A — git
git init -q && git add -A && git commit -qm "agent control room"
# then on the other Mac: git clone <remote> && cd pi-agents-redux-saga-extension

# option B — direct copy over the LAN
rsync -a --exclude node_modules --exclude dist --exclude .DS_Store \
  ~/Desktop/pi-agents-redux-saga-extension/ othermac:~/Desktop/pi-agents-redux-saga-extension/
```

`node_modules` and `dist` are both in `.gitignore`; rebuild from the lockfile.

## 1. Prerequisites on the other Mac

| Need | Why | Check |
| --- | --- | --- |
| Node **>= 22.19** | pi's `engines`; 22.18+ is also what lets `npm test` import `src/*.ts` directly | `node -v` |
| `pi` on `PATH` | the bridge spawns `pi --mode rpc` as a child process | `pi --version` |
| pi signed in | the bridge drives a real agent run | `~/.pi/agent/auth.json`, or a provider API key env var |
| npm deps | app + saga + vite | `npm ci` |

**nvm trap:** `server.cjs` spawns `pi` with the environment of whatever shell ran
`npm run agent-server`. If `pi` lives under an nvm version that isn't active in that
shell, the bridge starts fine and then the run dies with a silent `ENOENT`. `npm run
preflight` checks this for you.

## 2. Trust the project — the step that bites

`.pi/extensions` is **trust-gated**, and `pi --mode rpc` never shows a trust prompt: it
just silently skips protected resources. Verified on this machine:

```
pi --mode rpc            -> /dashboard MISSING     (30 commands)
pi --mode rpc -a         -> /dashboard REGISTERED  (31 commands)
```

So on a fresh Mac the dashboard command will simply not exist until you do one of:

```bash
cd ~/Desktop/pi-agents-redux-saga-extension
pi -a          # trust for this run, or answer "yes" at the prompt to persist it
```

Answering **yes** to the interactive prompt writes a permanent entry to
`~/.pi/agent/trust.json` — do that once and forget about it.

This now matters twice over. `.pi/extensions/agent-desk.ts` is what gives squad members their
cross-agent tools, so in an untrusted project the agents simply have no way to dispatch or
escalate — the desk will try to do the field work itself and the dashboard stays quiet. The
bridge spawns its own children and needs the same decision: run it with `BRIDGE_TRUST=1`
(passes `-a` to every child) unless the trust entry is already saved.

Two things are worth checking, and `npm run check:extension -- --approve` does both: the
`/dashboard` and `/desk-status` commands exist, and the desk line printed on stderr reports
which tools each role registered.

```bash
npm run check:extension -- --approve   # PASS /dashboard, PASS /desk-status + tool report
```

Real pi 0.85.1 reports, per role:

```
agent-desk: nypd:desk (desk) tools=dispatch_job,ask_user bridge=http://127.0.0.1:8787
agent-desk: nypd:crew (field) tools=escalate_to_desk bridge=http://127.0.0.1:8787
```

## 3. Run it

Two terminals, both in the project root:

```bash
npm run agent-server   # terminal 1 — Pi RPC bridge on 127.0.0.1:8787
npm run dev            # terminal 2 — Vite on 127.0.0.1:5173, proxies /api -> 8787
```

Then either open http://127.0.0.1:5173/ directly, or from a *trusted* pi session type
`/dashboard` (it shells out to `open -g <url>`, which backgrounds the browser tab).

Click **Run next task**. Expected: `runNumber` ticks, the orchestrator card goes
Working, the timeline fills with `Started` / `Thinking` / `Tool call` entries as the
agent actually works, and it ends on `Completed` (or `Connection lost` if the bridge
dies mid-run).

## 4. Fast checks

```bash
npm run preflight        # environment + ports + bridge contract, exit 1 on FAIL
npm test                 # 412 assertions, no browser, no model tokens
```

`npm test` stubs `EventSource`/`fetch`, so it passes on a machine with no pi installed
at all — it validates the store/saga/UI, not the live bridge. That's the split:
use `test/` for logic, `preflight` + `check:extension` for plumbing, and a real
**Run next task** click for the end-to-end path.

## 4b. Squad shape (two or three agents per project)

Every project runs as a squad of pi processes. The bridge spawns one member per role and
labels every stream frame with `project` / `role` / `agentId` / `frontDesk`, which is what lets
the dashboard tell "who is talking to me" apart from "who is busy".

| Env var | Default | Effect |
| --- | --- | --- |
| `PI_SQUAD` | `duo` | `duo` = desk + crew. `trio` adds a `lab` back-up member for medium projects. |
| `PI_PROJECT_PATH` | the bridge's cwd | The working directory the squad operates on. |
| `BRIDGE_PORT` / `BRIDGE_HOST` | `8787` / `127.0.0.1` | Bridge listen address. |
| `PI_APPROVAL_RANK` | `officer` | Highest rank that runs without a signature. `officer` gates anything that changes something (default); `detective` also lets changes through and gates only destructive work; `sergeant` opens the gate entirely. An unrecognised value makes the bridge refuse to start. An old `PI_REQUIRE_APPROVAL` setting is no longer read. |
| `BRIDGE_TRUST` | off | Adds `-a` to each spawned pi so project-local `.pi/extensions` load (see step 2). |

`PI_SQUAD=trio npm run agent-server`

A squad **must** contain a front-desk member. The bridge refuses to start without one, and
the store refuses to adopt one from the wire, because a squad with nobody at the desk is
just a spinner with extra steps. That is why `Unanswered` is the first metric on the page.

### The rank ladder

Every job carries a rank, and the desk is told to declare it honestly:

| Rank | Meaning | Default gate |
| --- | --- | --- |
| `officer` | read-only: look, list, diff | runs immediately |
| `detective` | changes things: edits, runs, writes (the default when unset) | one signature |
| `sergeant` | can destroy: deletes, history rewrites, pushing anywhere | **two** clicks |

The two-click rule for `sergeant` lives in the store, so the first click is never even sent;
what is enforced on both sides is that nothing reaches the crew without a person asking for it.
If the bridge refuses a decision (unknown or already-released job), the card returns to the queue
owing its full confirmations instead of sitting there looking live, and the refusal is logged.

### The approval gate

With the default ladder, work that changes anything does **not** reach a crew member. The bridge
holds the job, broadcasts `job_pending`, and the dashboard shows a card with the brief, who would
do it, which request it answers, and a rank badge; nothing runs until you press **Approve**
(**Confirm** twice for `sergeant`). **Decline** sends the reason back to the desk so it stops
waiting and can propose something else.
A job can be decided exactly once, and if the bridge refuses the decision the card comes back
rather than disappearing.

Read-only work can skip the gate deliberately: `dispatch_job(..., requiresApproval: false)`, or
raise the ladder with `PI_APPROVAL_RANK=detective` / `sergeant`. The dashboard states which posture it is
running under, under the message box — and that line comes from the bridge over the wire, not
from a default in the UI, so it cannot disagree with what is actually enforced.

### Who may talk to whom

| Role | Tools | Why |
| --- | --- | --- |
| desk (`frontDesk`) | `dispatch_job`, `ask_user` | hands work out, and is the only one allowed to put the wait on the user |
| crew / lab | `escalate_to_desk` | a field member can ask, but never the user: the bridge re-attributes it to the desk |

Bridge endpoints: `POST /api/reply` (user to desk, acknowledges before any work),
`/api/ask` (desk to user), `/api/escalate` (crew to desk), `/api/dispatch` (desk proposes work),
`/api/approve` and `/api/decline` (human decides), `/api/queue` (steer / follow_up into a running
member), `GET /api/status`, `GET /api/events`.

When a field member settles, the bridge pulls its last assistant text and hands it to the desk
as a fresh instruction to report to the user — that is how "the experiment hit a problem" turns
into something you actually hear about.

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| preflight: "this bridge predates the squad work" | a bridge from an earlier session is still on :8787 | `lsof -ti:8787 \| xargs kill` then `BRIDGE_TRUST=1 npm run agent-server` |
| Agents never dispatch, dashboard shows no conversation | project not trusted, so the extension's tools do not exist | `BRIDGE_TRUST=1` on the bridge; `pi -a` once for your own session |
| A proposed job sits there and nothing happens | that is the gate working | approve it on the dashboard, or raise `PI_APPROVAL_RANK` |
| A card says **Confirm** instead of **Approve** | that job is `sergeant` rank: it can destroy something | click it twice deliberately, or decline it |
| `/dashboard` not in pi's command list | project not trusted | `pi -a` once, then `npm run check:extension` |
| Dashboard opens but stays on the seed data | Vite picked another port (5173 busy) while the extension hardcodes `:5173`, or the bridge isn't running | free 5173, or edit `DASHBOARD_URL` in `.pi/extensions/dashboard.ts`; start `npm run agent-server` first |
| Timeline freezes on "Working" forever | old build without the fault handling | pull — `agent_end`/`bridge_closed`/SSE drop now surface as **Fault** |
| Cards spin but nothing happens | child `pi` unauthenticated or not on PATH | `npm run preflight`, check `pi credentials` / `pi CLI` |
| `EADDRINUSE :8787` | a bridge from an earlier session | `lsof -ti:8787 \| xargs kill` |
| Firewall prompt for `node` | macOS Application Firewall | allow local connections; both servers bind `127.0.0.1` only |
| Agent names are back to Orchestrator/Researcher/Builder | Names and added operators live in browser localStorage for the `http://127.0.0.1:5173` origin — they are not part of the project files | Rename them again on that machine; nothing server-side needs clearing |
| Want to view from another device | everything is bound to loopback | not supported as-is: change the bind address in `server.cjs` and `DASHBOARD_URL` |

## 6. Optional: skip the browser entirely

The bridge is just SSE + POST, so you can exercise the transport by hand:

```bash
curl -N http://127.0.0.1:8787/api/events          # watch Pi RPC JSON lines
curl -X POST http://127.0.0.1:8787/api/prompt \
  -H 'Content-Type: application/json' \
  -d '{"message":"Reply with exactly: pong"}'      # 202 accepted, events stream above
```

Note that any *non-empty* prompt spawns a real agent, so it costs tokens.
The empty-message variant (`'{"message":""}'`) returns 400 without spawning, which is
what `npm run preflight` uses as a safe liveness probe.
