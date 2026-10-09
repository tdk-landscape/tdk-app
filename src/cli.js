#!/usr/bin/env node
import { commonProjectScanRoots, discoverProjectRoot, discoverProjects, openBrowser, startAppServer } from "./app.js";

function parseArgs(args) {
  const options = { projects: [], scanRoots: [], port: 0, scan: true, open: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      const value = args[++index];
      if (!value) throw new Error("--project requires a directory path.");
      options.projects.push(value);
    } else if (arg === "--scan-root") {
      const value = args[++index];
      if (!value) throw new Error("--scan-root requires a directory path.");
      options.scanRoots.push(value);
    } else if (arg === "--no-scan") {
      options.scan = false;
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--port") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("--port must be an integer from 0 to 65535.");
      options.port = value;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

// A stray rejection or EPIPE (e.g. the app window closing) must not take the server down.
process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
process.on("uncaughtException", (error) => console.error("Uncaught exception:", error));
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: tdk-app [--project <path> ...] [--scan-root <path> ...] [--no-scan] [--no-open] [--port <port>]");
    process.exit(0);
  }
  const projects = discoverProjects({
    currentRoot: discoverProjectRoot(),
    projectRoots: options.projects,
    scanRoots: [...(options.scan ? commonProjectScanRoots() : []), ...options.scanRoots],
  });
  const { server, url } = await startAppServer({ projects, port: options.port });
  if (options.open) openBrowser(url).catch(() => {});
  console.log(`TDK App is running at ${url}`);
  console.log(`Found ${projects.length} TDK project${projects.length === 1 ? "" : "s"}.`);
  console.log("Press Ctrl+C to close the local command center.");
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (!options.open) process.stdin.on("end", shutdown).resume();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
