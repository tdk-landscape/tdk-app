import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { commonProjectScanRoots, discoverProjectRoot, discoverProjects, probeCli, resolveProjects, startAppServer } from "../src/app.js";

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

const supported = { state: "supported", lifecycle: true, version: "1.3.145", minVersion: "1.3.145", installUrl: "https://example.test", message: null };

function fakeCli({ version = "1.3.145", commands = ["start", "stop", "restart"], versionStatus = 0, versionStderr = "" } = {}) {
  const calls = [];
  const execute = async (_project, args) => {
    calls.push(args);
    if (args[0] === "--version") return { status: versionStatus, stdout: versionStatus ? "" : `${version}\n`, stderr: versionStderr };
    const known = commands.includes(args[0]);
    return { status: 0, stderr: "", stdout: known ? `Usage: tdk ${args[0]} [options]\n` : "Usage: tdk [options] [command]\n" };
  };
  return { execute, calls };
}

describe("TDK CLI capability probe", () => {
  it("reports lifecycle support for a capable CLI", async () => {
    const { execute } = fakeCli();
    const result = await probeCli(execute);
    assert.equal(result.state, "supported");
    assert.equal(result.lifecycle, true);
    assert.equal(result.version, "1.3.145");
  });

  it("reports stable 1.3.140 as unsupported with an actionable message", async () => {
    const { execute } = fakeCli({ version: "1.3.140", commands: [] });
    const result = await probeCli(execute);
    assert.equal(result.state, "unsupported");
    assert.equal(result.lifecycle, false);
    assert.match(result.message, /1\.3\.140.*Update to/);
  });

  it("reports a missing binary and a failing version check separately", async () => {
    const missing = await probeCli(fakeCli({ versionStatus: 1, versionStderr: "spawn tdk ENOENT" }).execute);
    assert.equal(missing.state, "missing");
    assert.match(missing.message, /TDK_BIN/);
    const failing = await probeCli(fakeCli({ versionStatus: 1 }).execute);
    assert.equal(failing.state, "failed");
    assert.equal(failing.lifecycle, false);
  });

  it("only runs read-only probe commands", async () => {
    const { execute, calls } = fakeCli();
    await probeCli(execute);
    assert(calls.every((args) => args.includes("--version") || args.includes("--help")));
  });
});

describe("TDK App local server", () => {
  it("rejects lifecycle actions without spawning a mutating command when unsupported", async () => {
    const calls = [];
    const runCommand = async (_project, args) => {
      calls.push(args);
      if (args[0] === "--version") return { status: 0, stdout: "1.3.140\n", stderr: "" };
      return { status: 0, stderr: "", stdout: "Usage: tdk [options] [command]\n" };
    };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand });
    const origin = new URL(started.url).origin;
    const headers = { "content-type": "application/json", origin, "x-tdk-token": started.token };
    const cliState = await (await fetch(`${origin}/api/cli`, { headers })).json();
    assert.equal(cliState.lifecycle, false);
    const response = await fetch(`${origin}/api/actions`, { method: "POST", headers, body: JSON.stringify({ project: "a", operation: "start" }) });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "cli_unsupported");
    assert.match(body.error, /Update to/);
    assert(!calls.some((args) => args.includes("--json")));
  });

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

  it("finds projects below scan roots and skips dependency folders", () => {
    const root = mkdtempSync(join(tmpdir(), "tdk-app-scan-"));
    tempDirs.push(root);
    const project = join(root, "workspace", "project");
    mkdirSync(join(project, ".tdk"), { recursive: true });
    writeFileSync(join(project, ".tdk", "project.json"), JSON.stringify({ project: { name: "workspace-project" } }));
    const ignored = join(root, "node_modules", "example");
    mkdirSync(join(ignored, ".tdk"), { recursive: true });
    writeFileSync(join(ignored, ".tdk", "project.json"), JSON.stringify({ project: { name: "ignored" } }));

    const projects = discoverProjects({ currentRoot: null, scanRoots: [root] });
    assert.deepEqual(projects.map((entry) => entry.root), [project]);
    assert(commonProjectScanRoots("/Users/example").includes("/var/www"));
  });

  it("reaches shallow projects before a large sibling tree exhausts the directory cap", () => {
    const root = mkdtempSync(join(tmpdir(), "tdk-app-scan-"));
    tempDirs.push(root);
    const project = join(root, "a-project");
    mkdirSync(join(project, ".tdk"), { recursive: true });
    writeFileSync(join(project, ".tdk", "project.json"), JSON.stringify({ project: { name: "shallow" } }));
    for (let index = 0; index < 20; index += 1) mkdirSync(join(root, "z-large", `dir-${index}`), { recursive: true });

    const projects = discoverProjects({ currentRoot: null, scanRoots: [root], maxDirectoriesPerRoot: 10 });
    assert.deepEqual(projects.map((entry) => entry.root), [project]);
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
    assert.match(await scriptResponse.text(), /function refreshData/);
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
    const started = await serverFor({ projects: [project], runCommand, probe: async () => supported });
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
