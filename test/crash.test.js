import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { checkDocker, discoverProjects, probeCli, resolveProjects, runTdk, startAppServer, summarizeDoctor } from "../src/app.js";

const TOKEN = "crash-test-token";
const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections?.(); server.close(done); })));
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix = "tdk-crash-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

const supported = { state: "supported", lifecycle: true, version: "1.3.145", minVersion: "1.3.145", installUrl: "https://example.test", message: null };
const projects = [
  { id: "a", name: "a", root: "/projects/a" },
  { id: "b", name: "b", root: "/projects/b" },
];
const okEnvelope = (data) => ({ status: 0, stderr: "", stdout: JSON.stringify({ data }) });
const goodStatus = okEnvelope({ resources: [{ name: "api", stack: "s", type: "backend", status: "ready" }], stacks: [{ name: "s" }], ports: [{ name: "api", hostPort: 8080 }], tilt: { resources: [{}] } });

async function boot(options = {}) {
  const started = await startAppServer({
    projects,
    port: 0,
    token: TOKEN,
    probe: async () => supported,
    runCommand: async () => goodStatus,
    openPath: async () => {},
    dockerCheck: async () => true,
    ...options,
  });
  servers.push(started.server);
  return started;
}

// Raw request so tests can control Host, Origin, method, headers and body exactly.
function raw(server, { method = "GET", path = "/", headers = {}, body, auth = true } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, method, path,
      headers: { host: `127.0.0.1:${port}`, ...(auth ? { "x-tdk-token": TOKEN } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const post = (server, path, body, extra = {}) => {
  const { port } = server.address();
  return raw(server, { method: "POST", path, body: typeof body === "string" ? body : JSON.stringify(body), headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, ...extra });
};

async function assertAlive(server) {
  const response = await raw(server, { path: "/api/cli" });
  assert.equal(response.status, 200, "server should still answer after the abuse");
}

describe("HTTP request abuse", () => {
  const malformedBodies = [
    ["invalid JSON", "{not json"],
    ["truncated JSON", '{"project":"a","operation":'],
    ["JSON null", "null"],
    ["JSON array", "[1,2,3]"],
    ["JSON string", '"start"'],
    ["JSON number", "42"],
    ["lone surrogate escape", '{"project":"\\ud800"}'],
    ["deeply nested JSON", `${"[".repeat(5000)}${"]".repeat(5000)}`],
    ["binary garbage", "\u0000\u0001\u0002�"],
  ];
  for (const [label, body] of malformedBodies) {
    for (const path of ["/api/actions", "/api/open"]) {
      it(`answers ${path} with a 4xx for ${label} and stays up`, async () => {
        const { server } = await boot();
        const response = await post(server, path, body);
        assert(response.status >= 400 && response.status < 500, `expected 4xx, got ${response.status}: ${response.text}`);
        await assertAlive(server);
      });
    }
  }

  it("rejects an oversized body without crashing", async () => {
    const { server } = await boot();
    const response = await post(server, "/api/actions", JSON.stringify({ project: "a", operation: "start", pad: "x".repeat(200_000) })).catch((error) => ({ status: 0, error }));
    assert(response.status === 0 || (response.status >= 400 && response.status < 500));
    await assertAlive(server);
  });

  it("requires the session token on every API route", async () => {
    const { server } = await boot();
    for (const path of ["/api/cli", "/api/projects", "/api/logs?project=a&resource=x"]) {
      assert.equal((await raw(server, { path, auth: false })).status, 403, path);
      assert.equal((await raw(server, { path, headers: { "x-tdk-token": "wrong" } })).status, 403, path);
      assert.equal((await raw(server, { path, headers: { "x-tdk-token": "" } })).status, 403, path);
      assert.equal((await raw(server, { path, headers: { "x-tdk-token": "a".repeat(10_000) } })).status, 403, path);
    }
    await assertAlive(server);
  });

  it("serves the page only with the right token", async () => {
    const { server } = await boot();
    assert.equal((await raw(server, { path: "/", auth: false })).status, 404);
    assert.equal((await raw(server, { path: "/?token=nope", auth: false })).status, 404);
    assert.equal((await raw(server, { path: `/?token=${TOKEN}`, auth: false })).status, 200);
    assert.equal((await raw(server, { path: "/?token=%E0%A4%A", auth: false })).status, 404);
    assert.equal((await raw(server, { path: "/?token=a&token=b", auth: false })).status, 404);
  });

  it("rejects wrong Host headers (DNS rebinding) and cross-origin requests", async () => {
    const { server } = await boot();
    for (const host of ["evil.example", "localhost:80", "127.0.0.1:1", "127.0.0.1"]) {
      const response = await raw(server, { path: "/api/cli", headers: { host } }).catch(() => ({ status: 400 }));
      assert([400, 403].includes(response.status), `host ${JSON.stringify(host)} -> ${response.status}`);
    }
    for (const origin of ["http://evil.example", "null", "http://127.0.0.1:1", "file://"]) {
      assert.equal((await raw(server, { path: "/api/cli", headers: { origin } })).status, 403, origin);
    }
    assert.equal((await post(server, "/api/actions", { project: "a", operation: "start" }, { headers: {} })).status, 403, "POST with no Origin");
    await assertAlive(server);
  });

  it("returns 404 for unknown paths, odd methods and path tricks", async () => {
    const { server } = await boot();
    for (const [method, path] of [
      ["GET", "/nope"], ["GET", "/api/"], ["GET", "/api/nope"], ["PUT", "/api/projects"], ["DELETE", "/api/projects"],
      ["PATCH", "/api/actions"], ["GET", "/api/actions"], ["GET", "/api/open"], ["POST", "/api/projects"], ["POST", "/api/cli"],
      ["OPTIONS", "/api/projects"], ["GET", "/../../etc/passwd"], ["GET", "/%2e%2e/%2e%2e/etc/passwd"], ["GET", "//evil.example/x"],
      ["GET", "/api/projects/../actions"], ["GET", "/%zz"], ["GET", "/index.html"], ["GET", "/public/app.js"], ["GET", "/src/app.js"],
    ]) {
      const response = await raw(server, { method, path }).catch((error) => ({ status: 0, error }));
      assert(response.status === 0 || [400, 403, 404].includes(response.status), `${method} ${path} -> ${response.status}`);
    }
    await assertAlive(server);
  });

  it("survives a very long URL and header flood", async () => {
    const { server } = await boot();
    const response = await raw(server, { path: `/api/logs?project=a&resource=${"x".repeat(20_000)}` }).catch((error) => ({ status: 431, error }));
    assert([200, 400, 404, 431, 414, 500].includes(response.status));
    const headers = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`x-flood-${index}`, "y".repeat(50)]));
    await raw(server, { path: "/api/cli", headers }).catch(() => {});
    await assertAlive(server);
  });

  it("survives clients that disconnect mid-request and slow or half-open sockets", async () => {
    const { server } = await boot();
    const { port } = server.address();
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(`POST /api/actions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-tdk-token: ${TOKEN}\r\nOrigin: http://127.0.0.1:${port}\r\nContent-Length: 500\r\n\r\n{"project":`);
          socket.destroy();
          resolve();
        });
        socket.on("error", resolve);
      });
    }
    await new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1", () => { socket.write("GARBAGE\r\n\r\n"); });
      socket.on("data", () => {});
      socket.on("close", resolve);
      socket.on("error", resolve);
      setTimeout(() => { socket.destroy(); resolve(); }, 300);
    });
    await assertAlive(server);
  });

  it("handles a burst of concurrent requests", async () => {
    const { server } = await boot();
    const results = await Promise.all(Array.from({ length: 100 }, () => raw(server, { path: "/api/projects" })));
    assert(results.every((result) => result.status === 200));
    await assertAlive(server);
  });
});

describe("API input validation", () => {
  const badActions = [
    ["missing everything", {}],
    ["unknown project", { project: "zzz", operation: "start" }],
    ["project is a number", { project: 1, operation: "start" }],
    ["project is an object", { project: { $ne: 1 }, operation: "start" }],
    ["project is an array", { project: ["a"], operation: "start" }],
    ["unknown operation", { project: "a", operation: "destroy" }],
    ["operation is an array", { project: "a", operation: ["start"] }],
    ["prototype key as project", { project: "__proto__", operation: "start" }],
    ["constructor as operation", { project: "a", operation: "constructor" }],
    ["resources is a string", { project: "a", operation: "start", resources: "api" }],
    ["resources has numbers", { project: "a", operation: "start", resources: [1, 2] }],
    ["resources has null", { project: "a", operation: "start", resources: [null] }],
    ["resources has empty names", { project: "a", operation: "start", resources: [""] }],
    ["resources has objects", { project: "a", operation: "start", resources: [{}] }],
    ["too many resources", { project: "a", operation: "start", resources: Array.from({ length: 31 }, (_, index) => `r${index}`) }],
    ["resource looks like a CLI flag", { project: "a", operation: "start", resources: ["--project=/etc"] }],
    ["stack looks like a CLI flag", { project: "a", operation: "start", stack: "--help" }],
  ];
  for (const [label, body] of badActions) {
    it(`rejects /api/actions: ${label}`, async () => {
      const calls = [];
      const { server } = await boot({ runCommand: async (...args) => { calls.push(args); return goodStatus; } });
      const response = await post(server, "/api/actions", body);
      assert.equal(response.status, 400, response.text);
      assert.equal(calls.length, 0, "no CLI command may run for invalid input");
      await assertAlive(server);
    });
  }

  it("never lets shell metacharacters reach a shell", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (_project, args) => { calls.push(args); return okEnvelope({}); } });
    const response = await post(server, "/api/actions", { project: "a", operation: "start", resources: ["api; rm -rf /", "$(whoami)", "`id`"] });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ["up", "--json", "--only", "api; rm -rf /", "$(whoami)", "`id`"]);
  });

  it("rejects /api/open with bad kinds and projects", async () => {
    const opened = [];
    const { server } = await boot({ openPath: async (...args) => { opened.push(args); } });
    for (const body of [{}, { project: "a" }, { kind: "project" }, { project: "zzz", kind: "project" }, { project: "a", kind: "shell" }, { project: "a", kind: ["project"] }, { project: "../etc", kind: "project" }]) {
      assert.equal((await post(server, "/api/open", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(opened.length, 0);
  });

  it("rejects /api/logs with missing, unknown, repeated or encoded parameters", async () => {
    const { server } = await boot();
    for (const path of ["/api/logs", "/api/logs?project=a", "/api/logs?resource=x", "/api/logs?project=zzz&resource=x", "/api/logs?project=a&resource=", "/api/logs?project=%00&resource=x"]) {
      const response = await raw(server, { path });
      assert.equal(response.status, 400, path);
    }
    await assertAlive(server);
  });

  it("does not allow a resource name to inject CLI flags into logs", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (_project, args) => { calls.push(args); return okEnvelope({ lines: [] }); } });
    const response = await raw(server, { path: "/api/logs?project=a&resource=--follow" });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

describe("CLI misbehaviour", () => {
  const garbage = [
    ["empty stdout", { status: 0, stderr: "", stdout: "" }],
    ["not JSON", { status: 0, stderr: "", stdout: "Segmentation fault" }],
    ["HTML error page", { status: 0, stderr: "", stdout: "<html>502</html>" }],
    ["JSON null", { status: 0, stderr: "", stdout: "null" }],
    ["JSON array", { status: 0, stderr: "", stdout: "[]" }],
    ["JSON string", { status: 0, stderr: "", stdout: '"hi"' }],
    ["JSON number", { status: 0, stderr: "", stdout: "42" }],
    ["data is null", { status: 0, stderr: "", stdout: '{"data":null}' }],
    ["errors only", { status: 1, stderr: "", stdout: '{"errors":[{"message":"boom"}]}' }],
    ["errors without messages", { status: 1, stderr: "", stdout: '{"errors":[null,{},"x"]}' }],
    ["non-zero exit, no output", { status: 1, stderr: "", stdout: "" }],
    ["killed (null status)", { status: null, stderr: "", stdout: "" }],
    ["stderr only", { status: 2, stderr: "permission denied", stdout: "" }],
    ["resources not an array", okEnvelope({ resources: "nope" })],
    ["resources is an object", okEnvelope({ resources: { a: 1 } })],
    ["resources contain null", okEnvelope({ resources: [null, 1, "x", []] })],
    ["resources missing names", okEnvelope({ resources: [{}, { name: 5 }, { name: null }] })],
    ["stacks not an array", okEnvelope({ stacks: 7 })],
    ["ports not an array", okEnvelope({ ports: "8080" })],
    ["ports contain null", okEnvelope({ ports: [null, 1, "x", {}] })],
    ["ports with string hostPort", okEnvelope({ ports: [{ name: "x", hostPort: "8080" }, { name: "y", hostPort: "8080" }] })],
    ["tilt is a string", okEnvelope({ tilt: "yes" })],
    ["huge resource list", okEnvelope({ resources: Array.from({ length: 5000 }, (_, index) => ({ name: `r${index}`, status: "ready" })) })],
    ["javascript: urls", okEnvelope({ resources: [{ name: "x", url: "javascript:alert(1)" }, { name: "y", url: { toString() {} } }] })],
    ["unicode and control characters", okEnvelope({ resources: [{ name: "\u0000‮<script>", stack: "\ud83d", status: "ready" }] })],
  ];
  for (const [label, result] of garbage) {
    it(`/api/projects survives: ${label}`, async () => {
      const { server } = await boot({ runCommand: async () => result });
      const response = await raw(server, { path: "/api/projects" });
      assert.equal(response.status, 200, response.text);
      assert(Array.isArray(response.json.projects));
      assert.equal(response.json.projects.length, projects.length, "every project should still be listed");
      await assertAlive(server);
    });
  }

  it("keeps listing healthy projects when one project's status fails", async () => {
    const { server } = await boot({ runCommand: async (project) => (project.id === "a" ? { status: 1, stderr: "boom", stdout: "" } : goodStatus) });
    const response = await raw(server, { path: "/api/projects" });
    assert.equal(response.status, 200, response.text);
    const byId = Object.fromEntries(response.json.projects.map((project) => [project.id, project]));
    assert(byId.a.error, "failed project reports an error");
    assert.equal(byId.b.resources.length, 1);
  });

  it("keeps listing when runCommand throws or rejects for one project", async () => {
    const { server } = await boot({ runCommand: async (project) => { if (project.id === "a") throw new Error("spawn exploded"); return goodStatus; } });
    const response = await raw(server, { path: "/api/projects" });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.projects.length, 2);
  });

  it("returns JSON errors for logs and actions when the CLI fails", async () => {
    const { server } = await boot({ runCommand: async () => { throw new Error("kaboom"); } });
    const logs = await raw(server, { path: "/api/logs?project=a&resource=api" });
    assert.equal(logs.status, 500);
    assert.match(logs.json.error, /kaboom/);
    const action = await post(server, "/api/actions", { project: "a", operation: "restart" });
    assert.equal(action.status, 500);
    assert.match(action.json.error, /kaboom/);
    await assertAlive(server);
  });

  it("tolerates logs payloads that are not arrays", async () => {
    for (const lines of ["text", 5, { a: 1 }, null]) {
      const { server } = await boot({ runCommand: async () => okEnvelope({ lines }) });
      const response = await raw(server, { path: "/api/logs?project=a&resource=api" });
      assert.equal(response.status, 200, response.text);
      assert(Array.isArray(response.json.lines));
    }
  });

  it("returns a JSON error when opening a folder fails", async () => {
    const { server } = await boot({ openPath: async () => { throw new Error("no such app"); } });
    const response = await post(server, "/api/open", { project: "a", kind: "terminal" });
    assert.equal(response.status, 500);
    assert.match(response.json.error, /no such app/);
    await assertAlive(server);
  });

  it("reports a failed capability probe instead of throwing", async () => {
    const { server } = await boot({ probe: async () => { throw new Error("probe blew up"); } });
    const response = await raw(server, { path: "/api/cli" });
    assert.equal(response.status, 200);
    assert.equal(response.json.lifecycle, false);
    assert.match(response.json.message, /probe blew up/);
    const action = await post(server, "/api/actions", { project: "a", operation: "start" });
    assert.equal(action.status, 409);
  });

  it("re-probes after a failed probe so installing the CLI is picked up", async () => {
    let calls = 0;
    const { server } = await boot({ probe: async () => (++calls === 1 ? { ...supported, state: "missing", lifecycle: false, message: "missing" } : supported) });
    assert.equal((await raw(server, { path: "/api/cli" })).json.lifecycle, false);
    assert.equal((await raw(server, { path: "/api/cli" })).json.lifecycle, true);
  });

  it("does not run lifecycle commands concurrently-unsafe: parallel actions all settle", async () => {
    const { server } = await boot({ runCommand: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return okEnvelope({}); } });
    const results = await Promise.all(Array.from({ length: 25 }, () => post(server, "/api/actions", { project: "a", operation: "restart" })));
    assert(results.every((result) => result.status === 200));
  });
});

describe("CLI self-update endpoint", () => {
  it("runs `tdk upgrade --yes` without sudo and re-probes", async () => {
    const calls = [];
    let probed = 0;
    const { server } = await boot({
      probe: async () => (++probed === 1 ? { ...supported, state: "unsupported", lifecycle: false, message: "old" } : supported),
      runCommand: async (_project, args) => { calls.push(args); return { status: 0, stdout: "upgraded", stderr: "" }; },
    });
    await raw(server, { path: "/api/cli" });
    const response = await post(server, "/api/cli/update", {});
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.cli.lifecycle, true);
    assert.deepEqual(calls, [["upgrade", "--yes"]]);
  });

  it("reports failure without throwing when the upgrade fails or the CLI is missing", async () => {
    for (const result of [{ status: 1, stdout: "", stderr: "EACCES" }, { status: null, stdout: "", stderr: "ENOENT" }]) {
      const { server } = await boot({ runCommand: async () => result });
      const response = await post(server, "/api/cli/update", {});
      assert.equal(response.status, 200);
      assert.equal(response.json.ok, false);
      await assertAlive(server);
    }
  });

  it("rejects overlapping updates and cross-origin callers", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { server } = await boot({ runCommand: async () => { await gate; return { status: 0, stdout: "", stderr: "" }; } });
    const first = post(server, "/api/cli/update", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await post(server, "/api/cli/update", {})).status, 409);
    assert.equal((await post(server, "/api/cli/update", {}, { headers: {} })).status, 403);
    assert.equal((await post(server, "/api/cli/update", {}, { headers: { origin: "http://evil.example" } })).status, 403);
    release();
    assert.equal((await first).status, 200);
  });

  it("is POST only", async () => {
    const { server } = await boot();
    assert.equal((await raw(server, { path: "/api/cli/update" })).status, 404);
  });
});

describe("doctor scores", () => {
  const report = (checks, ready = true) => ({ status: 0, stderr: "", stdout: JSON.stringify({ schemaVersion: 1, data: { ready, inProject: true, checks } }) });
  const pass = (name) => ({ name, didPass: true, message: "ok" });
  const warn = (name) => ({ name, didPass: false, isWarning: true, message: "careful", fix: "do x" });
  const fail = (name) => ({ name, didPass: false, message: "broken", fix: "do y" });

  it("scores pass=1, warning=0.5, fail=0 and ignores skipped checks", () => {
    const summary = summarizeDoctor({ ready: false, checks: [pass("a"), pass("b"), warn("c"), fail("d"), { name: "e", isSkipped: true, didPass: false }] });
    assert.equal(summary.score, 63);
    assert.deepEqual([summary.passed, summary.warnings, summary.failed, summary.total], [2, 1, 1, 4]);
    assert.equal(summary.checks.find((check) => check.name === "e").status, "skipped");
  });

  it("returns a null score instead of crashing for empty or malformed reports", () => {
    for (const data of [null, undefined, 5, "x", [], {}, { checks: "no" }, { checks: [null, 1, "x", []] }, { checks: [{}] }]) {
      const summary = summarizeDoctor(data);
      assert(summary.score === null || typeof summary.score === "number");
      assert(Array.isArray(summary.checks));
    }
  });

  it("serves /api/doctor and caches it so refreshes do not rerun the CLI", async () => {
    const calls = [];
    const { server } = await boot({ runCommand: async (project, args) => { calls.push(args); return report([pass("docker"), fail("ports")], false); } });
    const first = await raw(server, { path: "/api/doctor?project=a" });
    assert.equal(first.status, 200);
    assert.equal(first.json.score, 50);
    assert.equal(first.json.failed, 1);
    await raw(server, { path: "/api/doctor?project=a" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["doctor", "--json", "--no-ping"]);
    await raw(server, { path: "/api/doctor?project=a&refresh=1" });
    assert.equal(calls.length, 2);
  });

  it("runs doctor once for concurrent requests", async () => {
    let calls = 0;
    const { server } = await boot({ runCommand: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 50)); return report([pass("a")]); } });
    await Promise.all(Array.from({ length: 10 }, () => raw(server, { path: "/api/doctor?project=a" })));
    assert.equal(calls, 1);
  });

  it("reports a doctor failure or hang as an error payload, not a 500", async () => {
    for (const result of [{ status: null, stdout: "", stderr: "" }, { status: 1, stdout: "garbage", stderr: "boom" }, { status: 0, stdout: "null", stderr: "" }]) {
      const { server } = await boot({ runCommand: async () => result });
      const response = await raw(server, { path: "/api/doctor?project=a" });
      assert.equal(response.status, 200);
      assert(response.json.error);
    }
    const { server } = await boot({ runCommand: async () => { throw new Error("spawn exploded"); } });
    assert.match((await raw(server, { path: "/api/doctor?project=a" })).json.error, /spawn exploded/);
  });

  it("rejects unknown projects and needs the token", async () => {
    const { server } = await boot();
    assert.equal((await raw(server, { path: "/api/doctor?project=zzz" })).status, 400);
    assert.equal((await raw(server, { path: "/api/doctor" })).status, 400);
    assert.equal((await raw(server, { path: "/api/doctor?project=a", auth: false })).status, 403);
  });
});

describe("Docker preflight", () => {
  it("refuses start, stop and restart with a clear 503 when Docker is not responding, without running the CLI", async () => {
    const calls = [];
    const { server } = await boot({ dockerCheck: async () => false, runCommand: async (_p, args) => { calls.push(args); return okEnvelope({}); } });
    for (const operation of ["start", "stop", "restart"]) {
      const response = await post(server, "/api/actions", { project: "a", operation });
      assert.equal(response.status, 503, operation);
      assert.equal(response.json.code, "docker_unavailable");
      assert.match(response.json.error, /Docker/);
    }
    assert.equal(calls.length, 0);
  });

  it("treats a throwing Docker check as unavailable", async () => {
    const { server } = await boot({ dockerCheck: async () => { throw new Error("x"); } });
    assert.equal((await post(server, "/api/actions", { project: "a", operation: "start" })).status, 503);
  });

  it("checkDocker is false for a missing binary and a hung or failing one", async () => {
    assert.equal(await checkDocker(async () => ({ status: null, stdout: "", stderr: "ENOENT" })), false);
    assert.equal(await checkDocker(async () => ({ status: 1, stdout: "", stderr: "daemon not running" })), false);
    assert.equal(await checkDocker(async () => ({ status: 0, stdout: "27.0.1", stderr: "" })), true);
  });
});

describe("probeCli edge cases", () => {
  const run = (impl) => probeCli(async (_project, args) => impl(args));
  it("handles an execute that throws", async () => {
    await assert.rejects(() => run(() => { throw new Error("x"); }));
  });
  it("treats an empty version as unknown but not a crash", async () => {
    const result = await run((args) => (args[0] === "--version" ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: "Usage: tdk [options] [command]", stderr: "" }));
    assert.equal(result.lifecycle, false);
  });
  it("treats a timed-out version check (null status) as failed", async () => {
    const result = await run(() => ({ status: null, stdout: "", stderr: "" }));
    assert.equal(result.state, "failed");
  });
  it("does not match a lookalike command in help text", async () => {
    const result = await run((args) => (args[0] === "--version" ? { status: 0, stdout: "1.3.200\n", stderr: "" } : { status: 0, stdout: "Usage: tdk startup [options]", stderr: "" }));
    assert.equal(result.state, "unsupported");
  });
  it("handles garbage version strings", async () => {
    const result = await run((args) => (args[0] === "--version" ? { status: 0, stdout: "\u0000\n\n  \n", stderr: "" } : { status: 0, stdout: "", stderr: "" }));
    assert.equal(result.lifecycle, false);
  });
});

describe("runTdk process handling", () => {
  const node = process.execPath;
  const project = () => ({ root: tempDir() });

  it("resolves (never throws) when the binary does not exist", async () => {
    const result = await runTdk(project(), ["status"], { binary: "/definitely/not/a/tdk" });
    assert.equal(result.status, null);
    assert.match(result.stderr, /ENOENT/);
  });

  it("resolves when the project directory is gone", async () => {
    const result = await runTdk({ root: "/definitely/not/a/dir" }, ["--version"], { binary: node });
    assert.equal(result.status, null);
  });

  it("resolves when the binary is not executable", async () => {
    const directory = tempDir();
    const file = join(directory, "tdk");
    writeFileSync(file, "#!/bin/sh\n", { mode: 0o644 });
    const result = await runTdk({ root: directory }, [], { binary: file });
    assert.equal(result.status, null);
    assert.match(result.stderr, /EACCES/);
  });

  it("reports non-zero exit codes with their output", async () => {
    const result = await runTdk(project(), ["-e", "console.log('out');console.error('err');process.exit(3)"], { binary: node });
    assert.equal(result.status, 3);
    assert.equal(result.stdout.trim(), "out");
    assert.equal(result.stderr.trim(), "err");
  });

  it("kills a hung process at the timeout", async () => {
    const started = Date.now();
    const result = await runTdk(project(), ["-e", "setInterval(()=>{},1000)"], { binary: node, timeoutMs: 200 });
    assert.equal(result.status, null);
    assert(Date.now() - started < 5000);
  });

  it("kills a process that floods stdout", async () => {
    const result = await runTdk(project(), ["-e", "const b='x'.repeat(65536);setInterval(()=>process.stdout.write(b),1)"], { binary: node, timeoutMs: 20_000 });
    assert.equal(result.status, null);
    assert(result.stdout.length >= 2_000_000);
  });

  it("kills a process that floods stderr", async () => {
    const result = await runTdk(project(), ["-e", "const b='x'.repeat(65536);setInterval(()=>process.stderr.write(b),1)"], { binary: node, timeoutMs: 20_000 });
    assert.equal(result.status, null);
  });

  it("settles once even if the process errors after the timeout", async () => {
    const result = await runTdk(project(), ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { binary: node, timeoutMs: 150 });
    assert.equal(result.status, null);
  });

  it("handles a process that closes stdout early", async () => {
    const result = await runTdk(project(), ["-e", "process.stdout.end();setTimeout(()=>process.exit(0),50)"], { binary: node });
    assert.equal(result.status, 0);
  });

  it("copes with invalid UTF-8 output", async () => {
    const result = await runTdk(project(), ["-e", "process.stdout.write(Buffer.from([0xff,0xfe,0x80]))"], { binary: node });
    assert.equal(result.status, 0);
    assert.equal(typeof result.stdout, "string");
  });

  it("ignores a corrupt saved tilt port file", async () => {
    for (const content of ["", "{", "null", "[]", '{"port":"80"}', '{"port":-1}', '{"port":70000}', '{"port":1.5}', '{"port":null}']) {
      const directory = tempDir();
      mkdirSync(join(directory, ".tdk", ".tdk-out"), { recursive: true });
      writeFileSync(join(directory, ".tdk", ".tdk-out", "tilt-port.json"), content);
      const result = await runTdk({ root: directory }, ["-e", "console.log(process.env.TILT_PORT ?? 'none')"], { binary: node });
      assert.equal(result.stdout.trim(), "none", `port file ${JSON.stringify(content)}`);
    }
  });

  it("passes a valid saved tilt port through", async () => {
    const directory = tempDir();
    mkdirSync(join(directory, ".tdk", ".tdk-out"), { recursive: true });
    writeFileSync(join(directory, ".tdk", ".tdk-out", "tilt-port.json"), '{"port":10350}');
    const result = await runTdk({ root: directory }, ["-e", "console.log(process.env.TILT_PORT)"], { binary: node });
    assert.equal(result.stdout.trim(), "10350");
  });

  it("does not interpret arguments through a shell", async () => {
    const marker = join(tempDir(), "pwned");
    const result = await runTdk(project(), ["-e", "console.log(process.argv[1])", `; touch ${marker}`], { binary: node });
    assert.equal(result.status, 0);
    assert.throws(() => rmSync(marker), /ENOENT/);
  });

  it("copes with many parallel invocations", async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => runTdk(project(), ["-e", "console.log(1)"], { binary: node })));
    assert(results.every((result) => result.status === 0));
  });
});

describe("project discovery edge cases", () => {
  const makeProject = (root, name = "p", content) => {
    mkdirSync(join(root, ".tdk"), { recursive: true });
    writeFileSync(join(root, ".tdk", "project.json"), content ?? JSON.stringify({ project: { name } }));
  };

  it("ignores scan roots that do not exist or are files", () => {
    const directory = tempDir();
    writeFileSync(join(directory, "file"), "x");
    assert.deepEqual(discoverProjects({ currentRoot: null, scanRoots: ["/nope/nope", join(directory, "file"), ""] }), []);
  });

  it("does not follow symlink loops", () => {
    const directory = tempDir();
    mkdirSync(join(directory, "a"));
    symlinkSync(directory, join(directory, "a", "loop"));
    symlinkSync(join(directory, "a"), join(directory, "self"));
    assert.deepEqual(discoverProjects({ currentRoot: null, scanRoots: [directory] }), []);
  });

  it("stops at the depth limit", () => {
    const directory = tempDir();
    let deep = directory;
    for (let index = 0; index < 12; index += 1) deep = join(deep, `d${index}`);
    makeProject(deep);
    assert.deepEqual(discoverProjects({ currentRoot: null, scanRoots: [directory], maxDepth: 8 }), []);
    assert.equal(discoverProjects({ currentRoot: null, scanRoots: [directory], maxDepth: 20 }).length, 1);
  });

  it("stops at the directory and project caps", () => {
    const directory = tempDir();
    for (let index = 0; index < 30; index += 1) makeProject(join(directory, `p${String(index).padStart(2, "0")}`), `p${index}`);
    assert.equal(discoverProjects({ currentRoot: null, scanRoots: [directory], maxProjects: 5 }).length, 5);
    assert(discoverProjects({ currentRoot: null, scanRoots: [directory], maxDirectoriesPerRoot: 4 }).length <= 4);
  });

  it("falls back to the folder name for broken project.json files", () => {
    const directory = tempDir();
    const cases = ["", "{", "null", "[]", '"x"', "42", '{"project":null}', '{"project":{"name":5}}', '{"project":{"name":["a"]}}'];
    cases.forEach((content, index) => makeProject(join(directory, `case-${index}`), "x", content));
    const found = discoverProjects({ currentRoot: null, scanRoots: [directory] });
    assert.equal(found.length, cases.length);
    for (const project of found) assert.match(project.name, /^case-\d+$/);
  });

  it("de-duplicates the same project selected twice", () => {
    const directory = tempDir();
    makeProject(directory);
    assert.equal(discoverProjects({ currentRoot: directory, projectRoots: [directory, `${directory}/`, join(directory, ".", "")], scanRoots: [directory, directory] }).length, 1);
  });

  it("gives every project a distinct, stable id", () => {
    const directory = tempDir();
    for (const name of ["a", "b", "c"]) makeProject(join(directory, name));
    const first = discoverProjects({ currentRoot: null, scanRoots: [directory] });
    const second = discoverProjects({ currentRoot: null, scanRoots: [directory] });
    assert.deepEqual(first.map((project) => project.id), second.map((project) => project.id));
    assert.equal(new Set(first.map((project) => project.id)).size, 3);
  });

  it("rejects relative or missing explicit project roots", () => {
    assert.throws(() => resolveProjects(null, ["/definitely/missing"]), /Not a TDK project directory/);
    assert.throws(() => resolveProjects(null, [""]), /Not a TDK project directory/);
  });

  it("skips unreadable directories without throwing", () => {
    const directory = tempDir();
    mkdirSync(join(directory, "locked"));
    makeProject(join(directory, "open"));
    try { process.chmod?.call(process, 0); } catch {}
    rmSync(join(directory, "locked"), { recursive: true });
    assert.equal(discoverProjects({ currentRoot: null, scanRoots: [directory] }).length, 1);
  });
});

describe("server lifecycle", () => {
  it("refuses non-loopback hosts", () => {
    for (const host of ["0.0.0.0", "::", "localhost", "192.168.1.5", ""]) {
      assert.throws(() => startAppServer({ projects, host }), /127\.0\.0\.1/);
    }
  });

  it("fails cleanly when the port is already taken", async () => {
    const { server } = await boot();
    const { port } = server.address();
    await assert.rejects(() => startAppServer({ projects, port }), /EADDRINUSE/);
    await assertAlive(server);
  });

  it("rejects out-of-range ports", async () => {
    await assert.rejects(() => startAppServer({ projects, port: 70000 }));
  });

  it("starts with zero projects", async () => {
    const { server } = await boot({ projects: [] });
    const response = await raw(server, { path: "/api/projects" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.projects, []);
  });

  it("keeps serving after an error in a handler", async () => {
    let calls = 0;
    const { server } = await boot({ runCommand: async () => { if (++calls <= 2) throw new Error("transient"); return goodStatus; } });
    await raw(server, { path: "/api/logs?project=a&resource=x" });
    await raw(server, { path: "/api/logs?project=a&resource=x" });
    assert.equal((await raw(server, { path: "/api/projects" })).status, 200);
  });

  it("never sends the token in an API error body", async () => {
    const { server } = await boot();
    const response = await raw(server, { path: "/api/nope" });
    assert(!response.text.includes(TOKEN));
  });

  it("sets hardening headers on the page", async () => {
    const { server } = await boot();
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/?token=${TOKEN}`);
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
