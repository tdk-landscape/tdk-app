import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverProjectRoot, resolveProjects, startAppServer } from "../src/app.js";

const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectFixture(name) {
  const root = mkdtempSync(join(tmpdir(), "tdk-app-test-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".tdk"), { recursive: true });
  writeFileSync(join(root, ".tdk", "project.json"), JSON.stringify({ project: { name } }));
  return root;
}

async function serverFor(options) {
  const started = await startAppServer({ port: 0, token: "test-session-token", ...options });
  servers.push(started.server);
  return started;
}

describe("TDK App local server", () => {
  it("refuses non-loopback binds", async () => {
    assert.throws(() => startAppServer({ projects: [], host: "0.0.0.0" }), /only bind to 127\.0\.0\.1/);
  });

  it("discovers the nearest project and validates explicitly selected roots", () => {
    const root = projectFixture("shop");
    const nested = join(root, "src", "api");
    mkdirSync(nested, { recursive: true });
    assert.equal(discoverProjectRoot(nested), root);
    assert.equal(resolveProjects(root, [root]).length, 1);
    assert.throws(() => resolveProjects(null, [join(root, "missing")]), /Not a TDK project directory/);
  });

  it("returns project status and port conflicts from CLI JSON", async () => {
    const projects = [
      { id: "a", name: "a", root: "/projects/a" },
      { id: "b", name: "b", root: "/projects/b" },
    ];
    const runCommand = async (project, args) => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: args[0] === "status"
          ? { resources: [{ name: "api", stack: "shop", type: "backend", status: "ready" }], stacks: [{ name: "shop" }], ports: [{ name: "api", hostPort: 8080 }], tilt: { resources: [{}] } }
          : { services: [{ name: "api", url: "http://localhost:8080" }] },
      }),
    });
    const started = await serverFor({ projects, runCommand });
    const pageResponse = await fetch(started.url);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /<script src="\/app\.js" defer><\/script>/);
    const scriptResponse = await fetch(new URL("/app.js", started.url));
    assert.equal(scriptResponse.status, 200);
    assert.match(await scriptResponse.text(), /function refreshProjects/);
    const response = await fetch(new URL("/api/projects", started.url), {
      headers: { "x-tdk-token": started.token },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.projects[0].resources[0].url, "http://localhost:8080/");
    assert.deepEqual(body.projects[0].conflicts, [{ port: 8080, claimants: ["a (api)", "b (api)"] }]);
  });

  it("routes scoped actions through the installed TDK CLI", async () => {
    const project = { id: "a", name: "a", root: "/projects/a" };
    const calls = [];
    const runCommand = async (_project, args) => {
      calls.push(args);
      return { status: 0, stderr: "", stdout: JSON.stringify({ data: { operation: "restart" } }) };
    };
    const started = await serverFor({ projects: [project], runCommand });
    const origin = new URL(started.url).origin;
    const response = await fetch(`${origin}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-tdk-token": started.token },
      body: JSON.stringify({ project: "a", operation: "restart", resources: ["api"] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["restart", "--json", "--only", "api"]]);
  });
});
