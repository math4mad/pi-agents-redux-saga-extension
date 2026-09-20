import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Ranks are declared here rather than with pi-ai's StringEnum so this file
 * stays loadable outside pi (tests, typecheck). Type.Union of literals is what
 * StringEnum compiles down to, and the bridge treats an unknown rank as
 * 'detective' anyway, so a permissive schema is not a safety hole.
 */
const JobRank = Type.Union([Type.Literal("officer"), Type.Literal("detective"), Type.Literal("sergeant")]);

/**
 * Gives each member of a project squad the only cross-agent channels it is
 * allowed to use.
 *
 * The desk (front of house) talks to the user and hands work out. Field members
 * never reach the user directly: they escalate to the desk, and the bridge
 * rebroadcasts it attributed to the desk. That keeps "somebody always picks up"
 * true no matter how many crew members a project has.
 */

const BRIDGE_URL = process.env.PI_BRIDGE_URL ?? "http://127.0.0.1:8787";
const PROJECT = process.env.PI_PROJECT ?? "local";
const ROLE = process.env.PI_ROLE ?? "desk";
const IS_DESK = (process.env.PI_FRONT_DESK ?? (ROLE === "desk" ? "1" : "0")) === "1";

type BridgeResult = { ok: boolean; status: number; detail: string; data: Record<string, unknown> };

async function tellBridge(endpoint: string, body: Record<string, unknown>): Promise<BridgeResult> {
  try {
    const response = await fetch(`${BRIDGE_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: PROJECT, role: ROLE, ...body }),
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* the bridge answered without JSON; keep the raw text for the model */
    }
    return { ok: response.ok, status: response.status, detail: text, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, detail: `bridge unreachable: ${message}`, data: {} };
  }
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export default function (pi: ExtensionAPI) {
  const registered: string[] = [];
  const register = (definition: Parameters<typeof pi.registerTool>[0]) => {
    registered.push(definition.name);
    pi.registerTool(definition);
  };
  pi.registerCommand("desk-status", {
    description: "Show which squad member this session is and whether the bridge is reachable",
    handler: async (_args, ctx) => {
      const health = await tellBridge("/api/status", {});
      const line = `${PROJECT}:${ROLE} (${IS_DESK ? "front desk" : "field"}) -> ${BRIDGE_URL} ${health.ok ? "ok" : `unreachable (${health.status})`}`;
      ctx.ui.notify(line, health.ok ? "info" : "error");
    },
  });

  if (IS_DESK) {
    register({
      name: "dispatch_job",
      label: "Dispatch job to the crew",
      description:
        "Hand a concrete piece of work to a field member of this project's squad. The desk does not do field work itself.",
      promptSnippet: "Hand work to a crew member instead of doing it yourself",
      promptGuidelines: [
        "Use dispatch_job when the user asks for work to be performed; the desk routes the job and reports back rather than executing field work directly.",
        "Set the dispatch_job rank honestly: officer for read-only work, detective when files or runs change, sergeant when it could delete data, rewrite history, or push anywhere; the rank decides whether a human must sign it off.",
        "After dispatch_job returns, tell the user in your own words that the job was taken, because the user hears from the desk and never from the crew.",
      ],
      parameters: Type.Object({
        job: Type.String({ description: "What the crew member should do, stated as a complete instruction" }),
        role: Type.Optional(Type.String({ description: "Crew role to assign to. Defaults to the first field member." })),
        ticketId: Type.Optional(Type.Number({ description: "The user request this job answers, if known" })),
        requiresApproval: Type.Optional(Type.Boolean({ description: "Set false to run under the gate's own rule; true forces a human signature regardless of rank" })),
        rank: Type.Optional(JobRank),
      }),

      async execute(_toolCallId, params) {
        const result = await tellBridge("/api/dispatch", {
          job: params.job,
          targetRole: params.role,
          ticketId: params.ticketId,
          requiresApproval: params.requiresApproval,
          rank: params.rank,
        });
        if (!result.ok) return text(`Could not dispatch: ${result.detail}`);
        if (result.data.awaitingApproval === true) {
          const extra = result.data.confirmations > 1 ? ` The operator must confirm it ${result.data.confirmations} times.` : "";
          return text(`Queued for approval${extra}. Tell the user you have proposed it and that it needs their go-ahead; do not start the work yourself.`);
        }
        return text(`Dispatched. The crew has the job. Tell the user you picked it up and will report back. Body: ${result.detail}`);
      },
    });
    register({
      name: "ask_user",
      label: "Ask the user",
      description:
        "Put the wait on the user. Only for a decision the desk cannot make from the code, the config, or the conversation, because this marks the whole squad as blocked on the user.",
      promptSnippet: "Pause and ask the user when only they can decide",
      promptGuidelines: [
        "Use ask_user only for a decision the crew cannot make itself, because ask_user shows as waiting on the user everywhere.",
        "After ask_user returns, say the question plainly to the user and stop working on that item; the next move belongs to them.",
      ],
      parameters: Type.Object({
        question: Type.String({ description: "The question, answerable in one sentence" }),
        ticketId: Type.Optional(Type.Number({ description: "The user request this is blocking" })),
      }),

      async execute(_toolCallId, params) {
        const result = await tellBridge("/api/ask", {          question: params.question,
          ticketId: params.ticketId,
        });
        if (!result.ok) return text(`Could not surface the question: ${result.detail}`);
        return text("Asked. The user now sees this as waiting on them.");
      },
    });
  } else {
    register({
      name: "escalate_to_desk",
      label: "Escalate to the desk",
      description:
        "Ask the desk agent something. Field members never address the user directly; the desk decides whether the user needs to be asked.",
      promptSnippet: "Route questions and blockers to the desk, not the user",
      promptGuidelines: [
        "Use escalate_to_desk when you are blocked on a decision, need credentials or a preference, or finish a job in an unexpected state, because the user only ever hears from the desk.",
      ],
      parameters: Type.Object({
        question: Type.String({ description: "What needs deciding or knowing" }),
        blocking: Type.Optional(Type.Boolean({ description: "True when you cannot continue without an answer" })),
      }),

      async execute(_toolCallId, params) {
        const result = await tellBridge("/api/escalate", {
          question: params.question,
          blocking: params.blocking === true,
        });
        if (!result.ok) return text(`Could not reach the desk: ${result.detail}`);
        return text(
          params.blocking === true
            ? "Escalated. You are paused until the desk answers; say what you are waiting on and stop."
            : "Escalated. Carry on with what you can; the desk will come back to you.",
        );
      },
    });
  }

  // Self-report on stderr. The bridge forwards stderr as `bridge_log` frames,
  // so which role got which tools is observable without running a model.
  process.stderr.write(
    `agent-desk: ${PROJECT}:${ROLE} (${IS_DESK ? "desk" : "field"}) tools=${registered.join(",") || "none"} bridge=${BRIDGE_URL}\n`,
  );
}
