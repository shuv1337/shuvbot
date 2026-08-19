import { DASHBOARD_HTML } from "./ui.ts";
import { getRun, listRepositories, listRuns, parseRunFilters } from "./read-model.ts";
import { syncDashboard } from "./sync.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const READ_ONLY_HEADERS = {
  "cache-control": "private, max-age=30",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

export async function handleRequest(request: Request, env?: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405, { allow: "GET, HEAD" });
  }
  if (env === undefined) throw new Error("Dashboard environment is unavailable");
  const url = new URL(request.url);
  try {
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/api/repositories")
      return json({ repositories: await listRepositories(env.DB) });
    if (url.pathname === "/api/runs") {
      return json({ runs: await listRuns(env.DB, parseRunFilters(url)) });
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (runMatch?.[1] !== undefined) {
      const run = await getRun(env.DB, Number(runMatch[1]));
      return run === null ? json({ error: "Run not found" }, 404) : json({ run });
    }
    if (url.pathname === "/") {
      return new Response(request.method === "HEAD" ? null : DASHBOARD_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        }
      });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return json({ error: error.message }, 400);
    }
    console.error(
      JSON.stringify({
        message: "dashboard request failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return json({ error: "Internal server error" }, 500);
  }
}

function json<Value>(value: Value, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, {
    status,
    headers: { ...JSON_HEADERS, ...READ_ONLY_HEADERS, ...headers }
  });
}

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(_controller, env, ctx): void {
    ctx.waitUntil(
      syncDashboard(env).then((summary) => {
        console.log(JSON.stringify({ message: "dashboard sync completed", ...summary }));
      })
    );
  }
} satisfies ExportedHandler<Env>;
