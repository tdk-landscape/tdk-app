const token = document.querySelector('meta[name="tdk-token"]').content;
const content = document.querySelector("#content");
const projectList = document.querySelector("#project-list");
const search = document.querySelector("#search");
let projects = [];
let selectedProjectId = null;
let searchTerm = "";
let cli = null;

history.replaceState(null, "", location.pathname);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[char]);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-tdk-token": token,
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || "Request failed."), { code: body.code });
  return body;
}

function statusClass(value) {
  if (value === "ready" || value === "running") return "ready";
  if (value === "error" || value === "failed") return "error";
  return "";
}

function statusLabel(value) {
  if (value === "ready") return "Ready";
  if (value === "running") return "Running";
  if (value === "error" || value === "failed") return "Error";
  if (value === "stopped" || value === "not-running") return "Stopped";
  return value || "Unknown";
}

function statusMarkup(value) {
  return `<span class="status-label"><i class="state-dot ${statusClass(value)}"></i>${esc(statusLabel(value))}</span>`;
}

function symbolMarkup(name) {
  return `<span class="project-symbol" aria-hidden="true">${esc((name || "T").slice(0, 1).toUpperCase())}</span>`;
}

function actionButton(action, project, scope = "project", name = "", label = action[0].toUpperCase() + action.slice(1), extra = "") {
  return `<button class="button ${action === "start" ? "primary" : action === "stop" ? "danger" : ""} ${extra}" type="button" data-action="${esc(action)}" data-project="${esc(project.id)}" data-scope="${esc(scope)}" data-name="${esc(name)}">${esc(label)}</button>`;
}

function actionSet(project, scope = "project", name = "", compact = false) {
  const klass = compact ? "row-actions" : "detail-actions";
  return `<div class="${klass}">${actionButton("start", project, scope, name, "Start")}${scope === "project" ? `${actionButton("stop", project, scope, name, "Stop")}${actionButton("restart", project, scope, name, "Restart")}` : ""}</div>`;
}

function filteredProjects() {
  if (!searchTerm) return projects;
  const query = searchTerm.toLowerCase();
  return projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query));
}

function renderSidebar() {
  document.querySelector("#nav-count").textContent = projects.length;
  document.querySelector("#side-count").textContent = projects.length;
  const visible = filteredProjects();
  if (!visible.length) {
    projectList.innerHTML = `<div class="loading">${projects.length ? "No matching projects" : "No projects found"}</div>`;
    return;
  }
  projectList.innerHTML = visible.map((project) => `
    <button class="project-item ${project.id === selectedProjectId ? "active" : ""}" type="button" data-select-project="${esc(project.id)}" title="${esc(project.path)}">
      <span class="project-item-name">${esc(project.name)}</span>
    </button>`).join("");
}

function overviewGauges(ready, resources) {
  const scores = projects.map((project) => doctors.get(project.id)?.score).filter((score) => typeof score === "number");
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
  const running = projects.filter((project) => project.tiltRunning).length;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
  return [
    gaugeCard({ value: average, text: average == null ? "…" : String(average), title: "Average health", caption: scores.length ? `${scores.length} of ${projects.length} projects checked` : "Running tdk doctor…", cls: average == null ? "none" : undefined }),
    gaugeCard({ value: pct(ready, resources), text: `${ready}`, title: "Resources ready", caption: `${ready} of ${resources} resources`, cls: resources ? (ready === resources ? "good" : ready ? "warn" : "none") : "none" }),
    gaugeCard({ value: pct(running, projects.length), text: `${running}`, title: "Projects running", caption: `${running} of ${projects.length} projects`, cls: running ? "good" : "none" }),
  ].join("");
}

function renderOverview() {
  const visible = filteredProjects();
  const resources = projects.reduce((sum, project) => sum + (project.resources || []).length, 0);
  const ready = projects.reduce((sum, project) => sum + (project.resources || []).filter((resource) => resource.status === "ready").length, 0);
  document.querySelector("#breadcrumb").innerHTML = "<strong>Overview</strong>";
  document.querySelector("#overview-nav").classList.add("active");

  const rows = visible.map((project) => {
    const conflicts = (project.conflicts || []).length;
    return `<div class="project-row">
      <button class="project-open" type="button" data-select-project="${esc(project.id)}">${symbolMarkup(project.name)}<span class="row-title"><strong>${esc(project.name)}</strong><small>${esc(project.path)}</small></span></button>
      ${project.error ? `<span class="status-label"><i class="state-dot error"></i>Unavailable</span>` : statusMarkup(project.tiltRunning ? "running" : "stopped")}
      ${scoreMarkup(project)}
      <span class="row-meta resources-count" ${project.error ? `title="${esc(project.error)}"` : ""}>${project.error ? esc(project.error.slice(0, 60)) : `${(project.resources || []).length} resources${conflicts ? ` · ${conflicts} port conflicts` : ""}`}</span>
      ${actionSet(project, "project", "", true)}
    </div>`;
  }).join("");

  content.innerHTML = `<div class="content-inner">
    <div class="page-head"><div><h1>Projects</h1><p>${projects.length} local workspace${projects.length === 1 ? "" : "s"} discovered across your development folders.</p></div>
      </div>
    ${collapsible("summary", "Summary", `<div class="gauges">${overviewGauges(ready, resources)}</div>`)}
    <div id="notice" class="notice" role="status"></div>
    ${visible.length ? collapsible("projects", "Projects", `<section class="project-table" aria-label="TDK projects">${rows}</section>`, `${visible.length} shown`) : `<div class="empty"><span class="empty-icon">⌕</span><strong>${projects.length ? "No matching projects" : "No TDK projects found"}</strong><p>${projects.length ? "Try another project name or folder path." : "TDK App searches common development folders. Add a location with --scan-root or initialize a project with tdk project."}</p></div>`}
  </div>`;
}

function renderDetail(project) {
  const resources = project.resources || [];
  const grouped = new Map();
  for (const resource of resources) {
    const stack = resource.stack || "Unassigned";
    if (!grouped.has(stack)) grouped.set(stack, []);
    grouped.get(stack).push(resource);
  }
  const stacks = (project.stacks || []).map((stack) => stack.name);
  for (const name of grouped.keys()) if (name !== "Unassigned" && !stacks.includes(name)) stacks.push(name);
  if (grouped.has("Unassigned")) stacks.push("Unassigned");
  const conflicts = project.conflicts || [];
  const conflictPorts = new Set(conflicts.map((conflict) => conflict.port));
  const ports = (project.ports || []).map((port) => `<span class="port-chip ${conflictPorts.has(port.port) ? "conflict" : ""}">${esc(port.name)} · :${esc(port.port)}</span>`).join("");
  const conflictDetails = conflicts.length ? `<details class="conflicts"><summary>${conflicts.length} configured port conflict${conflicts.length === 1 ? "" : "s"}</summary><div class="conflict-body">${conflicts.map((conflict) => `<div>Port ${esc(conflict.port)} · ${esc((conflict.claimants || []).join(", "))}</div>`).join("")}</div></details>` : "";

  const stackMarkup = stacks.map((name) => {
    const items = grouped.get(name) || [];
    const resourcesMarkup = items.length ? items.map((resource) => `<div class="resource-row">
      <div class="resource-name" title="${esc(resource.name)}">${esc(resource.name)}${resource.type ? `<span class="resource-type">${esc(resource.type)}</span>` : ""}</div>
      ${statusMarkup(resource.status)}
      ${resource.url ? `<a class="resource-url" href="${esc(resource.url)}" target="_blank" rel="noreferrer">${esc(resource.url)}</a>` : `<span class="resource-url">No endpoint</span>`}
      <div class="resource-actions">${actionButton("start", project, "resource", resource.name)}<button class="button" type="button" data-action="logs" data-project="${esc(project.id)}" data-name="${esc(resource.name)}">Logs</button></div>
    </div>`).join("") : `<div class="resource-row"><span class="resource-name">No resources assigned</span></div>`;
    const quickActions = name === "Unassigned" ? "" : `<div class="stack-quick">${actionButton("start", project, "stack", name)}</div>`;
    return `<section class="stack ${closedStacks.has(`${project.id}/${name}`) ? "" : "open"}" data-stack="${esc(name)}" data-key="${esc(`${project.id}/${name}`)}"><div class="stack-head"><button class="stack-toggle" type="button" aria-expanded="${!closedStacks.has(`${project.id}/${name}`)}">${chevronMarkup()}<span class="stack-name">${esc(name)}</span><span class="stack-count">${items.length} resource${items.length === 1 ? "" : "s"}</span></button>${quickActions}</div><div class="resource-list">${resourcesMarkup}</div></section>`;
  }).join("");

  document.querySelector("#overview-nav").classList.remove("active");
  document.querySelector("#breadcrumb").innerHTML = `<button class="back-link" type="button" data-view-overview>Projects</button><span>›</span><strong>${esc(project.name)}</strong>`;
  content.innerHTML = `<div class="content-inner">
    <div id="notice" class="notice" role="status"></div>
    ${project.error ? `<div class="notice show error">Could not read status: ${esc(project.error)}</div>` : ""}
    <div class="detail-head"><div class="detail-title"><button class="back-link" type="button" data-view-overview>← All projects</button><h1>${esc(project.name)}</h1><code class="detail-path">${esc(project.path)}</code></div>
      <div class="detail-actions">${actionSet(project)}<button class="button" type="button" data-action="open-project" data-project="${esc(project.id)}">Open folder</button><button class="button" type="button" data-action="open-terminal" data-project="${esc(project.id)}">Open terminal</button></div></div>
    <div class="detail-meta">${statusMarkup(project.tiltRunning ? "running" : "stopped")}<span class="meta-item">${resources.length} resources</span><span class="meta-item">${stacks.length} stacks</span></div>
    ${ports ? `<div class="ports">${ports}</div>` : ""}${conflictDetails}
    ${doctorSection(project)}
    ${collapsible("stacks", "Stacks & resources", `<div class="stack-list">${stackMarkup || `<div class="empty"><span class="empty-icon">T</span><strong>No resources found</strong><p>Initialize this folder with the TDK CLI to add resources.</p></div>`}</div>`, `${resources.length} total`)}
  </div>`;
}

// Collapsed sections persist across launches (best effort; storage can be unavailable).
const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem("tdk-collapsed") || "[]"); } catch { return []; } })());
function saveCollapsed() { try { localStorage.setItem("tdk-collapsed", JSON.stringify([...collapsed])); } catch {} }

function collapsible(id, title, body, right = "") {
  const shut = collapsed.has(id);
  return `<section class="panel ${shut ? "collapsed" : ""}" data-panel="${esc(id)}"><div class="panel-head"><button class="panel-toggle" type="button" aria-expanded="${!shut}">${chevronMarkup()}<span>${esc(title)}</span></button><span class="panel-right">${right}</span></div><div class="panel-body">${body}</div></section>`;
}

function chevronMarkup() {
  return `<svg class="chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Stacks stay open across the 7-second refresh unless the user closed them.
const closedStacks = new Set();

function render() {
  const scrollTop = content.scrollTop;
  renderSidebar();
  const selected = projects.find((project) => project.id === selectedProjectId);
  if (selected) renderDetail(selected);
  else renderOverview();
  applyCliCapability();
  applyActiveNotice();
  applyBusy();
  content.scrollTop = scrollTop;
}

const doctors = new Map();
let doctorRunning = false;
let activeNotice = null;
const busy = new Set();

function scoreClass(score) {
  if (score == null) return "none";
  return score >= 90 ? "good" : score >= 60 ? "warn" : "bad";
}

// Circular gauge; value is 0-100 or null. Colour follows the same thresholds everywhere.
function ringMarkup({ value, text, label = "", size = 44, stroke = 5, cls = scoreClass(value), title = "" }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = value == null ? 0 : Math.max(0, Math.min(100, value)) / 100 * circumference;
  const fontSize = Math.round(size * (size >= 80 ? 0.26 : 0.34));
  return `<span class="ring ${cls}" style="width:${size}px;height:${size}px" ${title ? `title="${esc(title)}"` : ""} role="img" aria-label="${esc(label || text)}">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke-width="${stroke}"/><circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${filled} ${circumference}" transform="rotate(-90 ${size / 2} ${size / 2})"/><text x="${size / 2}" y="${size / 2}" dy=".35em" text-anchor="middle" font-size="${fontSize}">${esc(text)}</text></svg></span>`;
}

function scoreMarkup(project, size = 44) {
  const result = doctors.get(project.id);
  if (!result) return ringMarkup({ value: null, text: "…", size, cls: "none", title: "Running tdk doctor…" });
  if (result.error) return ringMarkup({ value: null, text: "—", size, cls: "none", title: `Doctor failed: ${result.error}` });
  return ringMarkup({ value: result.score, text: result.score == null ? "—" : String(result.score), size, title: `Health ${result.score ?? "—"}/100 · ${result.passed} passed, ${result.warnings} warnings, ${result.failed} failed`, label: `Health ${result.score}` });
}

function gaugeCard({ value, text, title, caption, cls }) {
  return `<div class="gauge">${ringMarkup({ value, text, size: 92, stroke: 9, cls: cls ?? scoreClass(value), label: title })}<div><strong>${esc(title)}</strong><span>${esc(caption)}</span></div></div>`;
}

function stackedBar(result) {
  const total = result.total || 1;
  const part = (count, cls) => (count ? `<i class="${cls}" style="flex:${count / total}" title="${count}"></i>` : "");
  return `<div class="bar" role="img" aria-label="${result.passed} passed, ${result.warnings} warnings, ${result.failed} failed">${part(result.passed, "pass")}${part(result.warnings, "warning")}${part(result.failed, "fail")}</div>`;
}

// Runs doctor one project at a time so a stuck Docker cannot spawn many hung checks.
async function loadDoctors(force = false) {
  if (doctorRunning) return;
  doctorRunning = true;
  try {
    for (const project of projects) {
      if (!force && doctors.has(project.id)) continue;
      try {
        doctors.set(project.id, await api(`/api/doctor?project=${encodeURIComponent(project.id)}${force ? "&refresh=1" : ""}`));
      } catch (error) {
        doctors.set(project.id, { error: error.message });
      }
      render();
    }
  } finally {
    doctorRunning = false;
  }
}

function doctorSection(project) {
  const result = doctors.get(project.id);
  const rerun = `<button class="button" type="button" data-action="doctor-refresh" data-project="${esc(project.id)}">Run again</button>`;
  if (!result) return collapsible("doctor", "Doctor", `<div class="doctor-box">Running tdk doctor…</div>`, rerun);
  if (result.error) return collapsible("doctor", "Doctor", `<div class="doctor-box"><div class="notice show error">Doctor could not finish: ${esc(result.error)}</div></div>`, rerun);
  const issues = result.checks.filter((check) => check.status === "fail" || check.status === "warning");
  const list = issues.length ? issues.map((check) => `<div class="doctor-item ${check.status}"><strong>${esc(check.name)}</strong><span>${esc(check.message)}</span>${check.fix ? `<code>${esc(check.fix)}</code>` : ""}</div>`).join("") : `<div class="doctor-item pass"><strong>All ${result.total} checks passed</strong></div>`;
  return collapsible("doctor", "Doctor", `<div class="doctor-box"><div class="doctor-summary">${scoreMarkup(project, 84)}<div class="doctor-meta"><strong>${result.score ?? "—"} / 100</strong><span>${result.passed} passed · ${result.warnings} warnings · ${result.failed} failed</span>${stackedBar(result)}</div></div>${list}</div>`, rerun);
}

const updateState = { running: false, message: "" };
const MANUAL_UPDATE = "curl -fsSL https://tdk-landscape.github.io/install.sh | sh";

async function updateCli() {
  updateState.running = true;
  updateState.message = "";
  render();
  try {
    const result = await api("/api/cli/update", { method: "POST", body: "{}" });
    cli = result.cli || cli;
    updateState.message = result.ok ? "TDK CLI updated." : `Update failed. Run this in a terminal instead:\n${MANUAL_UPDATE}\n\n${result.output || ""}`;
  } catch (error) {
    updateState.message = `Update failed: ${error.message}\nRun this in a terminal instead:\n${MANUAL_UPDATE}`;
  } finally {
    updateState.running = false;
  }
  await refreshData();
}

function applyCliCapability() {
  if (!cli || cli.lifecycle) return;
  for (const button of document.querySelectorAll('[data-action="start"], [data-action="stop"], [data-action="restart"]')) {
    button.disabled = true;
    button.title = "Not available with this TDK CLI version.";
  }
  const banner = document.createElement("div");
  banner.className = "notice show error cli-banner";
  banner.setAttribute("role", "alert");
  const canUpdate = cli.state === "unsupported" || cli.state === "failed";
  const update = canUpdate ? ` <button class="button" type="button" id="update-cli" ${updateState.running ? "disabled" : ""}>${updateState.running ? "Updating…" : "Update TDK CLI"}</button>` : "";
  const outcome = updateState.message ? `<div class="update-result">${esc(updateState.message)}</div>` : "";
  const link = cli.installUrl ? ` <a href="${esc(cli.installUrl)}" target="_blank" rel="noreferrer noopener">Install or update instructions</a>` : "";
  banner.innerHTML = `${esc(cli.message)}${link}${update}${outcome}`;
  banner.querySelector("#update-cli")?.addEventListener("click", updateCli);
  const inner = content.querySelector(".content-inner") || content;
  inner.prepend(banner);
}

async function refreshData() {
  try {
    cli = await api("/api/cli").catch(() => null);
    const response = await api("/api/projects");
    projects = response.projects || [];
    if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) selectedProjectId = null;
    render();
    void loadDoctors();
  } catch (error) {
    content.innerHTML = `<div class="content-inner"><div class="empty"><span class="empty-icon">!</span><strong>Couldn’t load projects</strong><p>${esc(error.message)}</p><button class="button" type="button" id="retry">Try again</button></div></div>`;
    document.querySelector("#retry")?.addEventListener("click", refreshData);
  }
}

let noticeTimer = null;

function applyActiveNotice() {
  const element = document.querySelector("#notice");
  if (!element || !activeNotice) return;
  element.textContent = activeNotice.message;
  element.classList.toggle("error", activeNotice.isError);
  element.classList.add("show");
  if (activeNotice.action) {
    const button = document.createElement("button");
    button.className = "button primary";
    button.type = "button";
    button.textContent = activeNotice.action.label;
    button.style.marginLeft = "12px";
    button.addEventListener("click", activeNotice.action.run);
    element.append(button);
  }
}

// Sticky notices (in-progress work) stay until replaced; others clear after a few seconds.
function showNotice(message, isError = false, sticky = false, action = null) {
  clearTimeout(noticeTimer);
  activeNotice = { message, isError, action };
  applyActiveNotice();
  if (!sticky && !action) {
    noticeTimer = setTimeout(() => {
      activeNotice = null;
      document.querySelector("#notice")?.classList.remove("show");
    }, 9000);
  }
}

function applyBusy() {
  for (const button of document.querySelectorAll('[data-action="start"], [data-action="stop"], [data-action="restart"]')) {
    if (busy.has(button.dataset.project)) {
      button.disabled = true;
      if (button.dataset.action === "start" || button.dataset.action === "restart") button.textContent = button.dataset.action === "start" ? "Starting…" : "Restarting…";
      else button.textContent = "Stopping…";
    }
  }
}

let fixingDocker = false;

async function fixDockerAndRetry(button) {
  if (fixingDocker) return;
  fixingDocker = true;
  showNotice("Restarting Docker Desktop… this usually takes 30–90 seconds. The start will continue automatically once Docker answers.", false, true);
  try {
    const result = await api("/api/docker/restart", { method: "POST", body: "{}" });
    if (!result.ok) return showNotice(result.message, true, true);
    showNotice("Docker is running again. Continuing…", false, true);
  } catch (error) {
    return showNotice(`Could not restart Docker: ${error.message}`, true, true);
  } finally {
    fixingDocker = false;
  }
  await handleAction(button);
}

async function handleAction(button) {
  const { action, project, scope, name } = button.dataset;
  if (action === "logs") {
    document.querySelector("#log-title").textContent = `Recent logs · ${name}`;
    document.querySelector("#log-body").textContent = "Loading…";
    document.querySelector("#logs").showModal();
    try {
      const result = await api(`/api/logs?project=${encodeURIComponent(project)}&resource=${encodeURIComponent(name)}`);
      document.querySelector("#log-body").textContent = (result.lines || []).map((line) => line.text || JSON.stringify(line)).join("\n") || "No recent logs.";
    } catch (error) {
      document.querySelector("#log-body").textContent = error.message;
    }
    return;
  }
  if (action === "open-project" || action === "open-terminal") {
    try {
      await api("/api/open", { method: "POST", body: JSON.stringify({ project, kind: action === "open-project" ? "project" : "terminal" }) });
      showNotice(action === "open-project" ? "Opened project folder." : "Opened project terminal.");
    } catch (error) {
      showNotice(error.message, true);
    }
    return;
  }

  if (action === "doctor-refresh") {
    doctors.delete(project);
    render();
    try { doctors.set(project, await api(`/api/doctor?project=${encodeURIComponent(project)}&refresh=1`)); } catch (error) { doctors.set(project, { error: error.message }); }
    render();
    return;
  }

  busy.add(project);
  const verb = { start: "Starting", stop: "Stopping", restart: "Restarting" }[action];
  const target = scope === "project" ? projects.find((entry) => entry.id === project)?.name || "project" : name;
  showNotice(`${verb} ${target}… this can take a few minutes while Docker pulls and starts containers.`, false, true);
  applyBusy();
  try {
    const payload = { project, operation: action };
    if (scope === "stack") payload.stack = name;
    if (scope === "resource") payload.resources = [name];
    const result = await api("/api/actions", { method: "POST", body: JSON.stringify(payload) });
    showNotice(result.message || `${action[0].toUpperCase()}${action.slice(1)} requested.`);
    setTimeout(refreshData, 500);
  } catch (error) {
    if (error.code === "docker_unavailable") {
      // Offer to fix Docker and then carry on with the original action.
      showNotice(error.message, true, true, { label: "Restart Docker and continue", run: () => fixDockerAndRetry(button) });
    } else showNotice(error.message, true);
  } finally {
    busy.delete(project);
    render();
  }
}

projectList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-select-project]");
  if (!button) return;
  selectedProjectId = button.dataset.selectProject;
  render();
});

content.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-view-overview")) {
    selectedProjectId = null;
    render();
    return;
  }
  if (button.hasAttribute("data-select-project")) {
    selectedProjectId = button.dataset.selectProject;
    render();
    return;
  }
  if (button.dataset.action) void handleAction(button);
});

content.addEventListener("click", (event) => {
  const panelToggle = event.target.closest(".panel-toggle");
  if (panelToggle) {
    const panel = panelToggle.closest(".panel");
    const shut = panel.classList.toggle("collapsed");
    panelToggle.setAttribute("aria-expanded", String(!shut));
    if (shut) collapsed.add(panel.dataset.panel); else collapsed.delete(panel.dataset.panel);
    saveCollapsed();
    return;
  }
  const toggle = event.target.closest(".stack-toggle");
  if (!toggle) return;
  const stack = toggle.closest(".stack");
  const open = stack.classList.toggle("open");
  toggle.setAttribute("aria-expanded", String(open));
  if (open) closedStacks.delete(stack.dataset.key);
  else closedStacks.add(stack.dataset.key);
});

search.addEventListener("input", () => {
  searchTerm = search.value.trim();
  render();
});

document.querySelector("#overview-nav").addEventListener("click", () => {
  selectedProjectId = null;
  render();
});
document.querySelector("#refresh").addEventListener("click", refreshData);
document.querySelector("#close-logs").addEventListener("click", () => document.querySelector("#logs").close());
refreshData();
setInterval(refreshData, 7000);

// Sidebar: collapse the whole sidebar (button or Cmd+B) and the Workspaces list.
const appShell = document.querySelector(".app");
function applySidebarState() {
  appShell.classList.toggle("side-hidden", collapsed.has("side"));
  document.querySelector(".sidebar").classList.toggle("ws-collapsed", collapsed.has("ws"));
  document.querySelector("#ws-toggle")?.setAttribute("aria-expanded", String(!collapsed.has("ws")));
}
function toggleKey(key) {
  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
  saveCollapsed();
  applySidebarState();
}
document.querySelector("#side-toggle").addEventListener("click", () => toggleKey("side"));
document.querySelector("#ws-toggle").addEventListener("click", () => toggleKey("ws"));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") { event.preventDefault(); toggleKey("side"); }
});
applySidebarState();
