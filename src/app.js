import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statfsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const PROJECT_FILE = join(".tdk", "project.json");
const PORT_FILE = join(".tdk", ".tdk-out", "tilt-port.json");
const MAX_BODY = 16 * 1024;
const MAX_SCAN_DEPTH = 8;
const MAX_DIRECTORIES_PER_ROOT = 25_000;
const MAX_DISCOVERED_PROJECTS = 500;
const SCAN_SKIP_NAMES = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "target", "dist", "build",
  ".cache", ".npm", ".bun", ".venv", "venv", ".tox", "Pods", "DerivedData",
]);
const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const CLIENT_SCRIPT = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

export function discoverProjectRoot(start = process.cwd()) {
  let directory = resolve(start);
  while (true) {
    if (existsSync(join(directory, PROJECT_FILE))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function projectName(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, PROJECT_FILE), "utf8"));
    return typeof value.project?.name === "string" ? value.project.name : basename(root);
  } catch {
    return basename(root);
  }
}

export function resolveProjects(currentRoot, additionalRoots = []) {
  const roots = [...new Set([...(currentRoot ? [resolve(currentRoot)] : []), ...additionalRoots.map((root) => resolve(root))])];
  return roots.map((root) => {
    if (!isAbsolute(root) || !existsSync(join(root, PROJECT_FILE))) {
      throw new Error(`Not a TDK project directory: ${root}`);
    }
    return {
      id: `project-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`,
      name: projectName(root),
      root,
    };
  });
}

export function commonProjectScanRoots(home = homedir()) {
  return [
    join(home, "ollama"),
    join(home, "Ollama"),
    "/var/www",
    join(home, "Codex"),
    join(home, "Documents", "Codex"),
    join(home, "GitHub"),
    join(home, "github"),
    join(home, "Documents", "GitHub"),
    join(home, "Documents", "github"),
    join(home, "src"),
    join(home, "Code"),
    join(home, "code"),
    join(home, "Projects"),
    join(home, "projects"),
    join(home, "Developer"),
    join(home, "dev"),
    join(home, "work"),
    join(home, "Work"),
    join(home, "workspace"),
    join(home, "Workspaces"),
    join(home, "Documents", "Projects"),
    join(home, "Documents", "Workspaces"),
  ];
}

export function discoverProjects({
  currentRoot = discoverProjectRoot(),
  projectRoots = [],
  scanRoots = commonProjectScanRoots(),
  maxDepth = MAX_SCAN_DEPTH,
  maxDirectoriesPerRoot = MAX_DIRECTORIES_PER_ROOT,
  maxProjects = MAX_DISCOVERED_PROJECTS,
} = {}) {
  const discovered = new Set(projectRoots.map((root) => resolve(root)));
  if (currentRoot) discovered.add(resolve(currentRoot));

  for (const scanRoot of [...new Set(scanRoots.map((root) => resolve(root)))]) {
    if (!existsSync(scanRoot)) continue;
    const queue = [{ path: scanRoot, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < maxDirectoriesPerRoot && discovered.size < maxProjects) {
      const current = queue.shift();
      visited += 1;
      if (existsSync(join(current.path, PROJECT_FILE))) {
        discovered.add(current.path);
        continue;
      }
      if (current.depth >= maxDepth) continue;
      let entries;
      try {
        entries = readdirSync(current.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || SCAN_SKIP_NAMES.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".tdk") continue;
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return resolveProjects(null, [...discovered]).sort((left, right) =>
    left.name.localeCompare(right.name) || left.root.localeCompare(right.root),
  );
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Never show the account name: the real home path and any other /Users/<name> become /Users/****.
export function maskPaths(text) {
  const home = homedir();
  const masked = join(dirname(home), "****");
  return text.split(home).join(masked).replace(/\/Users\/(?!\*{4})[^/\\"\s]+/g, "/Users/****");
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(maskPaths(JSON.stringify(data)));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > MAX_BODY) {
      request.destroy();
      throw new HttpError(413, "Request body is too large.");
    }
  }
  if (!body) return {};
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object.");
  }
  return value;
}

export const RESOURCE_TYPES = ["backend", "frontend", "worker", "mcp", "bring-your-own", "sdk"];
export const PROJECT_TEMPLATES = ["restaurant", "saas", "erp", "user-management", "ecommerce", "example"];
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

function actionResult(result) {
  return { ok: result.status === 0, timedOut: result.status == null, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4000) };
}

// New projects may only be created inside the user's home folder or the temp dir.
function allowedParent(parent) {
  if (typeof parent !== "string" || parent.includes("\0")) return null;
  if (parent === "~" || parent.startsWith("~/")) parent = join(homedir(), parent.slice(1));
  if (!isAbsolute(parent)) return null;
  try {
    const real = realpathSync(parent);
    if (!statSync(real).isDirectory()) return null;
    const roots = [homedir(), tmpdir()].map((root) => { try { return realpathSync(root); } catch { return root; } });
    return roots.some((root) => real === root || real.startsWith(root + sep)) ? real : null;
  } catch {
    return null;
  }
}

// CLI-supplied names are passed as argv; a leading "-" would be parsed as a flag.
const isArgName = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !value.startsWith("-") && !value.includes("\0");

function readMachine(result) {
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    envelope = null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(String(result.stderr ?? "").trim() || (result.status == null ? "TDK did not respond (timed out or could not start)." : `TDK returned invalid JSON (exit ${result.status}).`));
  }
  const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
  if ((result.status !== 0 || errors.length) && envelope.data == null) {
    throw new Error(errors.map((error) => error?.message).filter((message) => typeof message === "string" && message).join("\n") || String(result.stderr ?? "").trim() || "TDK command failed.");
  }
  if (envelope.data == null) throw new Error("TDK returned no data.");
  return envelope.data;
}

export function runTdk(project, args, { binary = process.env.TDK_BIN || "tdk", timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    let savedPort;
    try {
      const value = JSON.parse(readFileSync(join(project.root, PORT_FILE), "utf8"));
      if (Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) savedPort = value.port;
    } catch {}
    const env = { ...process.env, ...(savedPort ? { TILT_PORT: String(savedPort) } : {}) };
    const child = spawn(binary, args, {
      cwd: project.root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    };
    const stop = () => {
      child.kill("SIGTERM");
      // A CLI that ignores SIGTERM must not outlive the request.
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    };
    const timer = setTimeout(() => {
      stop();
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) {
        stop();
        finish(null);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) {
        stop();
        finish(null);
      }
    });
    child.once("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

export const MANUAL_UPDATE_COMMAND = "curl -fsSL https://tdk-landscape.github.io/install.sh | sh";
export const MIN_CLI_VERSION = null;
const INSTALL_URL = "https://github.com/tdk-landscape/tdk-cli-core#install";
// The CLI starts and stops through `up` and `down` (no scoped start/stop/restart exist).
const LIFECYCLE_COMMANDS = ["up", "down"];

// Non-mutating probe: `tdk --version` for display and `tdk <cmd> --help` per lifecycle command.
// Commander prints command-specific help ("Usage: tdk <cmd>") only when the command exists;
// an older CLI falls back to the root help ("Usage: tdk [options] [command]").
export async function probeCli(execute, cwd = process.cwd()) {
  const probe = { root: cwd };
  const base = { minVersion: MIN_CLI_VERSION, installUrl: INSTALL_URL, version: null };
  const versionResult = await execute(probe, ["--version"], { timeoutMs: 10_000 });
  if (versionResult.status !== 0) {
    const missing = /ENOENT/.test(versionResult.stderr);
    return {
      ...base,
      state: missing ? "missing" : "failed",
      lifecycle: false,
      message: missing
        ? `The tdk CLI was not found. Install the TDK CLI, or set TDK_BIN to its path.`
        : `The tdk CLI did not respond to a version check (${versionResult.stderr.trim() || "timeout or non-zero exit"}). Check TDK_BIN and your install.`,
    };
  }
  const version = versionResult.stdout.trim().split(/\s+/).pop() || null;
  for (const command of LIFECYCLE_COMMANDS) {
    const help = await execute(probe, [command, "--help"], { timeoutMs: 10_000 });
    if (help.status !== 0 || !new RegExp(`^Usage: tdk ${command}\\b`, "m").test(help.stdout)) {
      return {
        ...base,
        version,
        state: "unsupported",
        lifecycle: false,
        message: `TDK CLI ${version ?? "(unknown version)"} does not support \`tdk ${LIFECYCLE_COMMANDS.join("/")}\`. Update the CLI to enable Start, Stop and Restart; status, logs and endpoints still work.`,
      };
    }
  }
  return { ...base, version, state: "supported", lifecycle: true, message: null };
}

async function projectStatus(project, execute) {
  const status = readMachine(await execute(project, ["status", "--json", "--tilt"]));
  let services = [];
  try {
    services = readMachine(await execute(project, ["networks", "--json"])).services ?? [];
  } catch {}
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("TDK returned an unexpected status format.");
  const objects = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : []);
  const urls = new Map(objects(services).map((service) => [service.name, service.url]));
  return {
    project,
    resources: objects(status.resources).map((resource) => ({
      ...resource,
      url: safeUrl(urls.get(resource.name) ?? resource.url),
    })),
    stacks: objects(status.stacks),
    ports: objects(status.ports),
    tiltRunning: Boolean(status.tilt && typeof status.tilt === "object" && status.tilt.resources),
  };
}

// Turns `tdk doctor --json` data into a 0-100 score: pass = 1, warning = 0.5, fail = 0, skipped ignored.
export function summarizeDoctor(data) {
  const raw = data && typeof data === "object" && Array.isArray(data.checks) ? data.checks : [];
  const checks = raw.filter((check) => check && typeof check === "object").map((check) => ({
    name: typeof check.name === "string" ? check.name : "Unnamed check",
    status: check.isSkipped ? "skipped" : check.didPass ? "pass" : check.isWarning ? "warning" : "fail",
    message: typeof check.message === "string" ? check.message : "",
    fix: typeof check.fix === "string" ? check.fix : "",
  }));
  const counted = checks.filter((check) => check.status !== "skipped");
  const points = counted.reduce((sum, check) => sum + (check.status === "pass" ? 1 : check.status === "warning" ? 0.5 : 0), 0);
  return {
    score: counted.length ? Math.round((points / counted.length) * 100) : null,
    passed: counted.filter((check) => check.status === "pass").length,
    warnings: counted.filter((check) => check.status === "warning").length,
    failed: counted.filter((check) => check.status === "fail").length,
    total: counted.length,
    ready: Boolean(data?.ready),
    checks,
  };
}

export const DOCKER_UNAVAILABLE = "Docker isn't responding. Open Docker Desktop (or quit and reopen it if it is stuck), wait until it says it is running, then try again.";

// A nearly full disk is the most common reason Docker Desktop's engine stops answering.
export function lowDiskNote(path = homedir(), thresholdGb = 5) {
  try {
    const stats = statfsSync(path);
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    return freeGb < thresholdGb ? ` Your disk has only ${freeGb.toFixed(1)} GB free, which is the most likely cause. Free some space first (for example with \`docker system prune\` once Docker responds, or by deleting large files).` : "";
  } catch {
    return "";
  }
}

function freeGb(path = homedir()) {
  try {
    const stats = statfsSync(path);
    return (stats.bavail * stats.bsize) / 1024 ** 3;
  } catch {
    return Infinity;
  }
}

// Quits Docker Desktop (force-quitting if it is stuck), reopens it and waits until the engine answers.
export async function restartDockerDesktop({ check = checkDocker, run = (command, args) => runTdk({ root: homedir() }, args, { binary: command, timeoutMs: 20_000 }), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitMs = 240_000, platform = process.platform, free = freeGb } = {}) {
  if (platform !== "darwin") return { ok: false, message: "Restarting Docker automatically is only supported on macOS. Restart Docker manually." };
  const gb = free();
  if (gb < 2) return { ok: false, message: `Only ${gb.toFixed(1)} GB of disk is free, so Docker cannot start. Free at least 5 GB, then try again.` };
  await run("osascript", ["-e", 'tell application "Docker" to quit']);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const running = await run("pgrep", ["-f", "Docker Desktop"]);
    if (running.status !== 0) break;
    if (attempt === 4) await run("pkill", ["-9", "-f", "/Applications/Docker.app"]);
    await sleep(2500);
  }
  const opened = await run("open", ["-a", "Docker"]);
  if (opened.status !== 0) return { ok: false, message: "Could not open Docker Desktop. Is it installed in /Applications?" };
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    if (await check().catch(() => false)) return { ok: true, message: "Docker is running again." };
  }
  return { ok: false, message: "Docker Desktop was reopened but is still not responding. Check its window for errors." };
}

export async function checkDocker(execute = runTdk) {
  const result = await execute({ root: homedir() }, ["info", "--format", "{{.ServerVersion}}"], { binary: process.env.DOCKER_BIN || "docker", timeoutMs: 8000 });
  return result.status === 0;
}

function safeUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function findConflicts(snapshots) {
  const owners = new Map();
  for (const snapshot of snapshots) {
    for (const port of snapshot.ports) {
      const claimants = owners.get(port.hostPort) ?? [];
      claimants.push({ projectId: snapshot.project.id, label: `${snapshot.project.name} (${port.name})` });
      owners.set(port.hostPort, claimants);
    }
  }
  return [...owners].filter(([, claimants]) => claimants.length > 1).map(([port, claimants]) => ({ port, claimants }));
}

export function startAppServer({ projects, projectsReady = Promise.resolve(), probe = probeCli, host = "127.0.0.1", port = 0, token = randomBytes(32).toString("hex"), runCommand = runTdk, openPath = openProjectPath, dockerCheck = checkDocker, dockerRestart = restartDockerDesktop }) {
  if (host !== "127.0.0.1") throw new Error("TDK App can only bind to 127.0.0.1.");
  let capability = null;
  let updating = false;
  let restartingDocker = false;
  const doctorCache = new Map();
  const DOCTOR_TTL_MS = 120_000;
  const loadDoctor = (project, force) => {
    const cached = doctorCache.get(project.id);
    if (cached && !force && (cached.pending || Date.now() - cached.at < DOCTOR_TTL_MS)) return cached.promise;
    const entry = { at: Date.now(), pending: true };
    entry.promise = (async () => {
      try {
        const data = readMachine(await runCommand(project, ["doctor", "--json", "--no-ping"], { timeoutMs: 45_000 }));
        return { ...summarizeDoctor(data), at: new Date().toISOString() };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
      } finally {
        entry.pending = false;
        entry.at = Date.now();
      }
    })();
    doctorCache.set(project.id, entry);
    return entry.promise;
  };
  // Cache only a positive result so installing or updating the CLI is picked up on the next load.
  const cliCapability = async () => {
    if (capability?.lifecycle) return capability;
    const result = await probe(runCommand).catch((error) => ({
      state: "failed", lifecycle: false, version: null, minVersion: MIN_CLI_VERSION, installUrl: INSTALL_URL,
      message: `The tdk CLI could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    }));
    capability = result;
    return result;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const origin = `http://127.0.0.1:${actualPort}`;
      if (request.headers.host !== `127.0.0.1:${actualPort}`) return sendJson(response, 403, { error: "Invalid host." });
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/" && request.method === "GET") {
        if (!sameSecret(url.searchParams.get("token") ?? "", token)) return sendJson(response, 404, { error: "Not found." });
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        return response.end(HTML.replace("__TDK_CENTER_TOKEN__", token).replaceAll("tdk center", "tdk-app"));
      }
      if (url.pathname === "/app.js" && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        return response.end(CLIENT_SCRIPT);
      }
      if (!url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found." });
      if (!sameSecret(request.headers["x-tdk-token"]?.toString() ?? "", token)) return sendJson(response, 403, { error: "Invalid session token." });
      if (request.headers.origin && request.headers.origin !== origin) return sendJson(response, 403, { error: "Invalid origin." });
      if (request.method === "POST" && request.headers.origin !== origin) return sendJson(response, 403, { error: "A same-origin request is required." });

      if (url.pathname === "/api/cli" && request.method === "GET") {
        return sendJson(response, 200, await cliCapability());
      }
      if (url.pathname === "/api/cli/update" && request.method === "POST") {
        // Runs the CLI's own `tdk upgrade`; never elevates privileges. On failure the client shows the manual command.
        if (updating) return sendJson(response, 409, { error: "An update is already running." });
        updating = true;
        try {
          const result = await runCommand({ root: homedir() }, ["upgrade", "--yes"], { timeoutMs: 300_000 });
          capability = null;
          const cli = await cliCapability();
          return sendJson(response, 200, { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-2000), cli });
        } finally {
          updating = false;
        }
      }
      if (url.pathname === "/api/docker/restart" && request.method === "POST") {
        if (restartingDocker) return sendJson(response, 409, { error: "Docker is already being restarted." });
        restartingDocker = true;
        try {
          return sendJson(response, 200, await dockerRestart());
        } finally {
          restartingDocker = false;
        }
      }
      if (url.pathname === "/api/doctor" && request.method === "GET") {
        const project = projects.find((entry) => entry.id === url.searchParams.get("project"));
        if (!project) return sendJson(response, 400, { error: "Select a project." });
        return sendJson(response, 200, await loadDoctor(project, url.searchParams.get("refresh") === "1"));
      }
      if (url.pathname === "/api/projects" && request.method === "GET") {
        await projectsReady;
        // One broken project must not take the whole dashboard down.
        const snapshots = await Promise.all(projects.map((project) => projectStatus(project, runCommand).catch((error) => ({
          project, resources: [], stacks: [], ports: [], tiltRunning: false,
          error: error instanceof Error ? error.message : String(error),
        }))));
        const conflicts = findConflicts(snapshots);
        return sendJson(response, 200, {
          projects: snapshots.map((snapshot) => ({
            id: snapshot.project.id,
            name: snapshot.project.name,
            path: snapshot.project.root,
            tiltRunning: snapshot.tiltRunning,
            ...(snapshot.error ? { error: snapshot.error } : {}),
            resources: snapshot.resources,
            stacks: snapshot.stacks,
            ports: snapshot.ports.map((port) => ({ name: port.name, port: port.hostPort })),
            conflicts: conflicts.filter((conflict) => conflict.claimants.some((claimant) => claimant.projectId === snapshot.project.id)).map((conflict) => ({
              port: conflict.port,
              claimants: conflict.claimants.map((claimant) => claimant.label),
            })),
          })),
        });
      }
      if (url.pathname === "/api/logs" && request.method === "GET") {
        const project = projects.find((entry) => entry.id === url.searchParams.get("project"));
        const resource = url.searchParams.get("resource");
        if (!project || !isArgName(resource)) return sendJson(response, 400, { error: "Select a project and resource." });
        const result = readMachine(await runCommand(project, ["logs", "--json", "--tail", "100", "--service", resource]));
        return sendJson(response, 200, { lines: Array.isArray(result.lines) ? result.lines : [] });
      }
      if (url.pathname === "/api/actions" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        if (!project || typeof body.project !== "string" || !["start", "stop", "restart"].includes(body.operation)) return sendJson(response, 400, { error: "Choose a valid project and lifecycle action." });
        const cli = await cliCapability();
        if (!cli.lifecycle) {
          return sendJson(response, 409, { error: cli.message, code: "cli_unsupported", cli: { state: cli.state, version: cli.version, minVersion: cli.minVersion, installUrl: cli.installUrl } });
        }
        const hasStack = body.stack != null && body.stack !== "";
        if (hasStack && !isArgName(body.stack)) return sendJson(response, 400, { error: "Invalid stack name." });
        if (body.resources != null && (!Array.isArray(body.resources) || body.resources.length > 30 || !body.resources.every((name) => isArgName(name)))) return sendJson(response, 400, { error: "Invalid resource selection." });
        const scoped = hasStack || Boolean(body.resources?.length);
        // `tdk down` has no scope, so stop and restart act on the whole project.
        if (scoped && body.operation !== "start") return sendJson(response, 400, { error: "TDK can only stop or restart a whole project. Start accepts a stack or resources." });
        const dockerOk = await Promise.resolve(dockerCheck()).catch(() => false);
        if (!dockerOk) return sendJson(response, 503, { error: `${DOCKER_UNAVAILABLE}${lowDiskNote()}`, code: "docker_unavailable" });
        const up = ["up", "--json"];
        if (hasStack) up.push(body.stack);
        if (body.resources?.length) up.push("--only", ...body.resources);
        if (body.operation !== "start") readMachine(await runCommand(project, ["down", "--json", "--force"], { timeoutMs: 180_000 }));
        const result = body.operation === "stop" ? { operation: "stop" } : readMachine(await runCommand(project, up, { timeoutMs: 180_000 }));
        return sendJson(response, 200, { data: result, message: result.startedDetached ? "Startup launched; TDK will report readiness as it settles." : "TDK lifecycle operation completed." });
      }
      if (url.pathname === "/api/meta" && request.method === "GET") {
        const home = homedir();
        const roots = commonProjectScanRoots().filter((root) => existsSync(root));
        const tilde = (path) => (path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path);
        return sendJson(response, 200, { defaultParent: tilde(roots.find((root) => root.startsWith(home)) ?? home), roots: roots.map(tilde), templates: PROJECT_TEMPLATES, resourceTypes: RESOURCE_TYPES });
      }
      if (url.pathname === "/api/resources" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        const type = body.type ?? "backend";
        if (!project || !NAME_RE.test(body.name ?? "") || !RESOURCE_TYPES.includes(type)) return sendJson(response, 400, { error: "Choose a project, a kebab-case resource name and a valid type." });
        const args = ["resource", body.name, "--type", type, "--yes"];
        for (const [flag, value, test] of [["--stack", body.stack, NAME_RE], ["--framework", body.framework, ID_RE], ["--language", body.language, ID_RE]]) {
          if (value == null || value === "") continue;
          if (typeof value !== "string" || !test.test(value)) return sendJson(response, 400, { error: `Invalid ${flag.slice(2)}.` });
          args.push(flag, value);
        }
        if (body.port != null && body.port !== "") {
          if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) return sendJson(response, 400, { error: "Invalid port." });
          args.push("--port", String(body.port));
        }
        const result = actionResult(await runCommand(project, args, { timeoutMs: 300_000 }));
        doctorCache.delete(project.id);
        return sendJson(response, 200, result);
      }
      if (url.pathname === "/api/stacks" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        const names = body.resources;
        if (!project || !NAME_RE.test(body.name ?? "") || !Array.isArray(names) || !names.length || names.length > 30 || !names.every((name) => typeof name === "string" && NAME_RE.test(name))) {
          return sendJson(response, 400, { error: "Choose a project, a kebab-case stack name and at least one resource." });
        }
        const result = actionResult(await runCommand(project, ["stack", body.name, "--resources", ...names, "--yes"], { timeoutMs: 120_000 }));
        return sendJson(response, 200, result);
      }
      if (url.pathname === "/api/config" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        const commands = { regenerate: ["config", "regenerate"], verify: ["project", "--check"] };
        if (!project || typeof body.operation !== "string" || !Object.hasOwn(commands, body.operation)) return sendJson(response, 400, { error: "Choose a project and regenerate or verify." });
        return sendJson(response, 200, actionResult(await runCommand(project, commands[body.operation], { timeoutMs: 120_000 })));
      }
      if (url.pathname === "/api/projects/create" && request.method === "POST") {
        const body = await readBody(request);
        const parent = allowedParent(body.parent);
        const template = body.template == null || body.template === "" ? null : body.template;
        if (!parent) return sendJson(response, 400, { error: "Choose an existing folder inside your home directory." });
        if (!NAME_RE.test(body.name ?? "")) return sendJson(response, 400, { error: "Project name must be kebab-case, for example my-shop." });
        if (template && !PROJECT_TEMPLATES.includes(template)) return sendJson(response, 400, { error: "Unknown template." });
        const target = join(parent, body.name);
        if (existsSync(target)) return sendJson(response, 409, { error: `${target} already exists.` });
        let result;
        if (template) {
          result = actionResult(await runCommand({ root: parent }, ["project", template, "--path", target, "--yes"], { timeoutMs: 300_000 }));
        } else {
          mkdirSync(target);
          result = actionResult(await runCommand({ root: target }, ["project", "--yes"], { timeoutMs: 120_000 }));
          if (!result.ok) { try { rmdirSync(target); } catch {} }
        }
        if (result.ok && existsSync(join(target, PROJECT_FILE))) {
          const [created] = resolveProjects(null, [target]);
          if (!projects.some((entry) => entry.root === created.root)) projects.push(created);
          return sendJson(response, 200, { ...result, project: { id: created.id, name: created.name, path: created.root } });
        }
        return sendJson(response, 200, { ...result, ok: false, output: result.output || "TDK did not create a project here." });
      }
      if (url.pathname === "/api/open" && request.method === "POST") {
        const body = await readBody(request);
        const project = typeof body.project === "string" ? projects.find((entry) => entry.id === body.project) : null;
        if (!project || !["project", "terminal"].includes(body.kind)) return sendJson(response, 400, { error: "Choose a valid project and open action." });
        await openPath(project.root, body.kind);
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 404, { error: "Not found." });
    })().catch((error) => {
      if (!response.headersSent) sendJson(response, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolvePromise({ server, token, url: `http://127.0.0.1:${address.port}/?token=${token}` });
    });
  });
}

export function openProjectPath(root, kind) {
  let command;
  let args;
  if (kind === "project") {
    if (process.platform === "darwin") [command, args] = ["open", [root]];
    else if (process.platform === "win32") [command, args] = ["explorer.exe", [root]];
    else [command, args] = ["xdg-open", [root]];
  } else if (process.platform === "darwin") [command, args] = ["open", ["-a", "Terminal", root]];
  else if (process.platform === "win32") [command, args] = ["wt.exe", ["-d", root]];
  else [command, args] = ["x-terminal-emulator", ["--working-directory", root]];
  return spawnDetached(command, args, root, process.platform === "win32");
}

export function openBrowser(url) {
  if (process.platform === "darwin") return spawnDetached("open", [url]);
  if (process.platform === "win32") return spawnDetached("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  return spawnDetached("xdg-open", [url]);
}

function spawnDetached(command, args, cwd, windowsHide = true) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}
