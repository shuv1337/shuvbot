import { DASHBOARD_HTML } from "./ui.ts";
import { getRun, listRepositories, listRuns, parseRunFilters } from "./read-model.ts";
import { isDashboardSyncConfigured, syncDashboard } from "./sync.ts";

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
  const url = new URL(request.url);
  try {
    if (env === undefined) throw new Error("Dashboard environment is unavailable");
    if (url.pathname === "/health") return json({ status: "ok" }, 200, {}, request.method);
    if (url.pathname === "/api/repositories")
      return json({ repositories: await listRepositories(env.DB) }, 200, {}, request.method);
    if (url.pathname === "/api/runs") {
      return json({ runs: await listRuns(env.DB, parseRunFilters(url)) }, 200, {}, request.method);
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (runMatch?.[1] !== undefined) {
      const id = Number(runMatch[1]);
      if (!Number.isSafeInteger(id)) throw new TypeError("Run id must be a safe integer");
      const run = await getRun(env.DB, id);
      return run === null
        ? json({ error: "Run not found" }, 404, {}, request.method)
        : json({ run }, 200, {}, request.method);
    }
    if (url.pathname === "/") {
      return new Response(request.method === "HEAD" ? null : DASHBOARD_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, max-age=30",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        }
      });
    }
    return json({ error: "Not found" }, 404, {}, request.method);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return json({ error: error.message }, 400, {}, request.method);
    }
    console.error(
      JSON.stringify({
        message: "dashboard request failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return json({ error: "Internal server error" }, 500, {}, request.method);
  }
}

function json<Value>(
  value: Value,
  status = 200,
  headers: Record<string, string> = {},
  method = "GET"
): Response {
  const response = Response.json(value, {
    status,
    headers: { ...JSON_HEADERS, ...READ_ONLY_HEADERS, ...headers }
  });
  return method === "HEAD" ? new Response(null, response) : response;
}

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(_controller, env, ctx): void {
    if (!isDashboardSyncConfigured(env)) {
      console.warn(
        JSON.stringify({
          message: "dashboard sync skipped",
          reason: "GitHub App secrets are not configured"
        })
      );
      return;
    }
    ctx.waitUntil(
      syncDashboard(env).then(
        (summary) => {
          console.log(JSON.stringify({ message: "dashboard sync completed", ...summary }));
        },
        (error: Error) => {
          console.error(
            JSON.stringify({
              message: "dashboard sync failed",
              error: error instanceof Error ? error.message : String(error)
            })
          );
          throw error;
        }
      )
    );
  }
} satisfies ExportedHandler<Env>;
