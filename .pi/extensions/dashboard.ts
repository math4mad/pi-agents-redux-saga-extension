import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Follows the server: PI_DASHBOARD_URL lets a LAN-reachable dashboard be the one
// /dashboard opens, instead of a loopback address another device cannot see.
const DASHBOARD_URL = process.env.PI_DASHBOARD_URL ?? "http://127.0.0.1:5173/";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("dashboard", {
    description: "Open the Pi Agent Control Room dashboard",
    handler: async (_args, ctx) => {
      const command = process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
      const args = process.platform === "darwin"
        ? ["-g", DASHBOARD_URL]
        : process.platform === "win32"
          ? ["/c", "start", "", DASHBOARD_URL]
          : [DASHBOARD_URL];
      const result = await pi.exec(command, args, { timeout: 5000 });

      if (result.code === 0) {
        ctx.ui.notify(`Dashboard opened at ${DASHBOARD_URL}`, "info");
      } else {
        ctx.ui.notify(`Could not open the dashboard. Start the live server with npm run dev. ${result.stderr}`.trim(), "error");
      }
    },
  });
}
