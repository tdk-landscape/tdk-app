# TDK App

TDK App is a local browser dashboard for operating TDK projects. It shows project, stack, and resource health, recent logs, endpoints, and configured port conflicts. It can start, stop, or restart a project, stack, or resource and open its folder or a terminal.

The app runs on your machine and uses the installed `tdk` CLI for status and lifecycle operations. It does not connect to a hosted control plane. Start, Stop, and Restart need a TDK CLI that provides the scoped `tdk start`, `tdk stop`, and `tdk restart` commands (TDK CLI 1.3.145 or newer). On load the app runs non-mutating probes (`tdk --version` and `tdk <command> --help`). If the CLI is older, missing, or not responding, lifecycle controls are disabled with an explanation, `POST /api/actions` returns HTTP 409 (`cli_unsupported`) without running anything, and status, endpoints, ports, logs, and folder/terminal actions keep working.

## Run from a checkout

Requires Node.js 22.12 or newer and TDK CLI on `PATH`.

```sh
npm start
npm start -- --project ~/src/storefront --project ~/src/billing
npm start -- --scan-root ~/workspaces
npm start -- --no-scan --project ~/src/storefront
npm start -- --port 43120
```

TDK App automatically searches common development locations, including `/var/www`, `~/ollama`, `~/Codex`, `~/Documents/Codex`, `~/GitHub`, `~/Documents/GitHub`, `~/src`, `~/Projects`, and `~/Developer`. It also includes the project containing the current directory. Scans are bounded to eight directory levels and skip dependency, build, and version-control folders. Use repeatable `--scan-root` options to add locations, `--project` to add a specific project root, or `--no-scan` to disable the common-location scan. Every selected project must contain `.tdk/project.json`.

`--port 0` (the default) selects an available local port.

The server binds only to `127.0.0.1`, protects the browser session with a random in-memory token, and exits with the app process. Closing the dashboard does not stop project resources. The terminal dashboard `tdk ui` remains available independently.

## macOS app

A lightweight native app (about 200 KB, a WKWebView shell, no Electron) that runs the same server in its own window:

```sh
./macos/build.sh
open "dist/TDK App.app"
```

Requires Xcode Command Line Tools to build and Node.js 22.12+ on your login-shell `PATH` to run. The app starts the server with `--no-open` and stops it when you quit.

## Install as a command

After a package release, install the published package globally and run:

```sh
npm install --global @tdk-landscape/tdk-app
tdk-app
```

The package is not published yet; use the checkout instructions above until a release is available.

## Development

```sh
npm test
```

The server uses Node.js built-ins only. Set `TDK_BIN` to the path of a TDK CLI executable if it is not named `tdk` or is not on `PATH`.
