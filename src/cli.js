#!/usr/bin/env node
import { discoverProjectRoot, openBrowser, resolveProjects, startAppServer } from "./app.js";

function parseArgs(args) {
  const options = { projects: [], port: 0 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      const value = args[++index];
      if (!value) throw new Error("--project requires a directory path.");
      options.projects.push(value);
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

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: tdk-app [--project <path> ...] [--port <port>]");
    process.exit(0);
  }
  const projects = resolveProjects(discoverProjectRoot(), options.projects);
  const { server, url } = await startAppServer({ projects, port: options.port });
  openBrowser(url).catch(() => {});
  console.log(`TDK App is running at ${url}`);
  console.log("Press Ctrl+C to close the local command center.");
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
