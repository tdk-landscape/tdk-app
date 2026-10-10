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
  if (!response.ok) throw Object.assign(new Error(body.error || "Request failed."), { code: body.code, lowDisk: body.lowDisk });
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

const ICONS = {
  start: '<path d="M6 4.5v11l9-5.5z" fill="currentColor"/>',
  stop: '<rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/>',
  restart: '<path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5V7h-3.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  logs: '<path d="M5 3.5h7l3 3v10H5z M12 3.5v3h3 M7.5 10h5M7.5 13h5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>',
  folder: '<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.8H16A1.5 1.5 0 0 1 17.5 7.8v6.7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/>',
  terminal: '<rect x="2.5" y="4" width="15" height="12" rx="2.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="m6 8 2.5 2L6 12M10.5 12.5H14" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  stack: '<path d="m10 3.5 7 3.5-7 3.5L3 7zM3 10.5l7 3.5 7-3.5M3 14l7 3.5 7-3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>',
  move: '<path d="M4 10h11M11 5.5 15.5 10 11 14.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  regenerate: '<path d="M4 10a6 6 0 0 1 10.5-4M16 10a6 6 0 0 1-10.5 4M14.5 3v3.5H11M5.5 17v-3.5H9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  verify: '<path d="M10 2.8 16 5v4.6c0 3.6-2.4 6-6 7.6-3.6-1.6-6-4-6-7.6V5z M7.2 10l2 2 3.6-3.8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>',
  pin: '<path d="M12.5 3.5 16.5 7.5 13.6 9.2 11.2 13.3 6.7 8.8 10.8 6.4z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><path d="M8.9 11.1 4 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  hide: '<path d="M3 10s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z M4 4l12 12" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};
const ACTION_ICONS = { start: "start", stop: "stop", restart: "restart", logs: "logs", "open-project": "folder", "open-terminal": "terminal", "new-project": "plus", "new-resource": "plus", "new-stack": "stack", "move-resource": "move", "config-regenerate": "regenerate", "config-verify": "verify", "hide-project": "hide", "pin-project": "pin", "pin-resource": "pin", "doctor-refresh": "restart" };

// Adds a small SF-Symbol-style glyph in front of each action button label.
function decorateButtons(root = document) {
  for (const button of root.querySelectorAll("button[data-action]:not([data-iconed])")) {
    const icon = ICONS[ACTION_ICONS[button.dataset.action]];
    button.dataset.iconed = "1";
    if (icon) button.insertAdjacentHTML("afterbegin", `<svg class="btn-icon" viewBox="0 0 20 20" aria-hidden="true">${icon}</svg>`);
  }
}

function actionButton(action, project, scope = "project", name = "", label = action[0].toUpperCase() + action.slice(1), extra = "") {
  return `<button class="button ${action === "start" ? "primary" : action === "stop" ? "danger" : ""} ${extra}" type="button" data-action="${esc(action)}" data-project="${esc(project.id)}" data-scope="${esc(scope)}" data-name="${esc(name)}">${esc(label)}</button>`;
}

// Borderless, icon-only toolbar button (tooltip carries the label).
function iconButton(action, title, data = {}) {
  const attrs = Object.entries(data).map(([key, value]) => `data-${key}="${esc(value)}"`).join(" ");
  return `<button class="icon-btn" type="button" data-action="${esc(action)}" data-iconed="1" ${attrs} title="${esc(title)}" aria-label="${esc(title)}"><svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[ACTION_ICONS[action]] || ""}</svg></button>`;
}

// "Inspect with" links that open Grok, Claude or Codex with the TDK output already in the prompt (see inspect.js).
// Renders nothing while AI inspect is off, so the buttons are not shown at all.
function inspectRow(prompt, className = "") {
  if (!aiInspect) return "";
  const links = TDK_INSPECT.providerLinks(prompt).map((link) => `<a class="ai-btn" href="${esc(link.href)}" target="_blank" rel="noreferrer noopener" style="--ai: ${link.color}" title="Open ${esc(link.label)} with this prompt"><svg viewBox="0 0 24 24" aria-hidden="true">${link.logo}</svg>${esc(link.label)}</a>`).join("");
  return `<div class="ai-row ${className}"><span class="ai-label">Inspect with</span>${links}</div>`;
}

function menuButton(items) {
  return `<div class="menu-wrap"><button class="icon-btn" type="button" data-menu title="More actions" aria-label="More actions" aria-haspopup="menu"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="15" cy="10" r="1.5" fill="currentColor"/></svg></button><div class="menu" role="menu" hidden>${items.map((item) => item === "-" ? `<hr>` : `<button type="button" role="menuitem" data-action="${esc(item.action)}" data-iconed="1" ${Object.entries(item.data || {}).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ")}><svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[ACTION_ICONS[item.action]] || ""}</svg>${esc(item.label)}</button>`).join("")}</div></div>`;
}

function actionSet(project, scope = "project", name = "", compact = false) {
  const klass = "row-actions";
  return `<div class="${klass}">${actionButton("start", project, scope, name, "Start")}${scope === "project" ? `${actionButton("stop", project, scope, name, "Stop")}${actionButton("restart", project, scope, name, "Restart")}` : ""}</div>`;
}

// UI state lives in a file via /api/state: the page origin (random port) changes every launch, so browser storage would forget it.
const hidden = new Set();
const pinnedProjects = new Set();
const pinnedResources = new Set();
// "Inspect with AI" buttons are off until the user switches them on in the Recent logs dialog.
let aiInspect = false;
let logView = null; // the logs dialog's current resource and lines
let stateLoaded = false;
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void api("/api/state", { method: "PUT", body: JSON.stringify({ hidden: [...hidden], collapsed: [...collapsed], pins: { projects: [...pinnedProjects], resources: [...pinnedResources] }, aiInspect }) }).catch(() => {});
  }, 200);
}
async function loadState() {
  try {
    const state = await api("/api/state");
    for (const id of state.hidden || []) hidden.add(id);
    for (const id of state.collapsed || []) collapsed.add(id);
    for (const id of state.pins?.projects || []) pinnedProjects.add(id);
    for (const key of state.pins?.resources || []) pinnedResources.add(key);
    aiInspect = state.aiInspect === true;
  } catch {}
  stateLoaded = true;
  applySidebarState();
}
const PIN_GLYPH = '<svg class="pin-glyph" viewBox="0 0 20 20" aria-label="Pinned"><path d="M12.5 3.5 16.5 7.5 13.6 9.2 11.2 13.3 6.7 8.8 10.8 6.4z" fill="currentColor"/><path d="M8.9 11.1 4 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
let showHidden = false;
function saveHidden() { saveState(); }

function filteredProjects() {
  const base = (showHidden ? [...projects] : projects.filter((project) => !hidden.has(project.id)))
    .sort((left, right) => Number(pinnedProjects.has(right.id)) - Number(pinnedProjects.has(left.id)));
  if (!searchTerm) return base;
  const query = searchTerm.toLowerCase();
  return base.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query));
}

function renderSidebar() {
  document.querySelector("#nav-count").textContent = projects.length;
  document.querySelector("#side-count").textContent = projects.length;
  const visible = filteredProjects();
  if (!visible.length) {
    projectList.innerHTML = `<div class="loading">${projects.length ? "No matching projects" : "No projects found"}</div>`;
    return;
  }
  const item = (project) => `
    <button class="project-item ${project.id === selectedProjectId ? "active" : ""}" type="button" data-select-project="${esc(project.id)}" title="${esc(project.name)} · ${esc(project.path)}">
      ${symbolMarkup(project.name)}<span class="project-item-name">${esc(project.name)}</span>${pinnedProjects.has(project.id) ? PIN_GLYPH : ""}
    </button>`;
  const pinned = visible.filter((project) => pinnedProjects.has(project.id));
  const rest = visible.filter((project) => !pinnedProjects.has(project.id));
  projectList.innerHTML = pinned.length
    ? `<div class="side-group">Pinned</div>${pinned.map(item).join("")}${rest.length ? `<div class="side-group">All projects</div>${rest.map(item).join("")}` : ""}`
    : rest.map(item).join("");
}

function pinnedResourcesPanel() {
  const rows = [];
  for (const key of pinnedResources) {
    const slash = key.indexOf("/");
    const project = projects.find((entry) => entry.id === key.slice(0, slash));
    const resource = project?.resources?.find((entry) => entry.name === key.slice(slash + 1));
    if (!project || !resource) continue;
    rows.push(`<div class="resource-row pinned-row">
      <div class="resource-name" title="${esc(resource.name)}">${esc(resource.name)}<span class="resource-type">${esc(project.name)}${resource.type ? ` · ${esc(resource.type)}` : ""}</span></div>
      ${statusMarkup(resource.status)}
      ${resource.url ? `<a class="resource-url" href="${esc(resource.url)}" target="_blank" rel="noreferrer">${esc(resource.url)}</a>` : `<span class="resource-url">No endpoint</span>`}
      <div class="resource-actions">${iconButton("start", `Start ${resource.name}`, { project: project.id, scope: "resource", name: resource.name })}${iconButton("logs", "Recent logs", { project: project.id, name: resource.name })}${iconButton("pin-resource", "Unpin resource", { project: project.id, name: resource.name, pinned: "1" })}</div>
    </div>`);
  }
  if (!rows.length) return "";
  return collapsible("pinned-resources", "Pinned resources", `<div class="stack open pinned-list"><div class="resource-list">${rows.join("")}</div></div>`, `${rows.length} pinned`);
}

function overviewGauges(ready, resources) {
  const scores = projects.map((project) => doctors.get(project.id)?.score).filter((score) => typeof score === "number");
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
  const running = projects.filter((project) => project.tiltRunning).length;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
  return [
    gaugeCard({ value: average, text: average == null ? "…" : String(average), sub: average == null ? "" : "of 100", title: "Average health", caption: scores.length ? `${scores.length} of ${projects.length} projects checked` : "Running tdk doctor…", cls: average == null ? "none" : undefined }),
    gaugeCard({ value: pct(ready, resources), text: `${ready}`, sub: `of ${resources}`, title: "Resources ready", caption: `${ready} of ${resources} resources`, cls: resources ? (ready === resources ? "good" : ready ? "warn" : "none") : "none" }),
    gaugeCard({ value: pct(running, projects.length), text: `${running}`, sub: `of ${projects.length}`, title: "Projects running", caption: `${running} of ${projects.length} projects`, cls: running ? "good" : "none" }),
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
      <button class="project-open" type="button" data-select-project="${esc(project.id)}">${symbolMarkup(project.name)}<span class="row-title"><strong>${esc(project.name)}${pinnedProjects.has(project.id) ? PIN_GLYPH : ""}</strong><small>${esc(project.path)}</small></span></button>
      ${project.pending ? `<span class="status-label"><i class="state-dot"></i>Checking…</span>` : project.error ? `<span class="status-label"><i class="state-dot error"></i>Unavailable</span>` : statusMarkup(project.tiltRunning ? "running" : "stopped")}
      ${scoreMarkup(project)}
      <span class="row-meta resources-count" ${project.error ? `title="${esc(project.error)}"` : ""}>${project.pending ? "" : project.error ? esc(project.error.slice(0, 60)) : `${(project.resources || []).length} resources${conflicts ? ` <span class="badge warn" title="${conflicts} configured port conflicts">${conflicts} conflicts</span>` : ""}`}</span>
      ${actionSet(project, "project", "", true)}
      ${progressMarkup(project.id, true)}
    </div>`;
  }).join("");

  content.innerHTML = `<div class="content-inner">
    <div class="page-head"><div><h1>Projects</h1><p>${projects.length} local workspace${projects.length === 1 ? "" : "s"} discovered across your development folders.</p>${hidden.size ? `<div class="hidden-note">${hidden.size} hidden · <button type="button" data-action="toggle-hidden">${showHidden ? "Hide them again" : "Show them"}</button></div>` : ""}</div>
      <div class="head-actions"><button class="button" type="button" data-action="build-with-ai">Build with AI</button><button class="button primary" type="button" data-action="new-project">New project</button></div></div>
    ${collapsible("summary", "Summary", `<div class="gauges">${overviewGauges(ready, resources)}</div>`)}
    ${pinnedResourcesPanel()}
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
      <div class="resource-actions">${iconButton("start", `Start ${resource.name}`, { project: project.id, scope: "resource", name: resource.name })}${iconButton("move-resource", "Move to another stack", { project: project.id, name: resource.name, stack: resource.stack || "" })}${iconButton("logs", "Recent logs", { project: project.id, name: resource.name })}${iconButton("pin-resource", pinnedResources.has(`${project.id}/${resource.name}`) ? "Unpin resource" : "Pin resource", { project: project.id, name: resource.name, pinned: pinnedResources.has(`${project.id}/${resource.name}`) ? "1" : "0" })}</div>
    </div>`).join("") : `<div class="resource-row"><span class="resource-name">No resources assigned</span></div>`;
    const quickActions = name === "Unassigned" ? "" : `<div class="stack-quick">${iconButton("start", `Start stack ${name}`, { project: project.id, scope: "stack", name })}</div>`;
    return `<section class="stack ${closedStacks.has(`${project.id}/${name}`) ? "" : "open"}" data-stack="${esc(name)}" data-key="${esc(`${project.id}/${name}`)}"><div class="stack-head"><button class="stack-toggle" type="button" aria-expanded="${!closedStacks.has(`${project.id}/${name}`)}">${chevronMarkup()}<span class="stack-name">${esc(name)}</span><span class="stack-count">${items.length} resource${items.length === 1 ? "" : "s"}</span></button>${quickActions}</div><div class="resource-list">${resourcesMarkup}</div></section>`;
  }).join("");

  document.querySelector("#overview-nav").classList.remove("active");
  document.querySelector("#breadcrumb").innerHTML = `<button class="back-link" type="button" data-view-overview>Projects</button><span>›</span><strong>${esc(project.name)}</strong>`;
  content.innerHTML = `<div class="content-inner">
    <div id="notice" class="notice" role="status"></div>
    ${project.error ? `<div class="notice show error">Could not read status: ${esc(project.error)}</div>` : ""}
    <div class="detail-head"><div class="detail-title"><button class="back-link" type="button" data-view-overview>← All projects</button><h1>${esc(project.name)}</h1><code class="detail-path">${esc(project.path)}</code></div>
      <div class="detail-actions">${actionSet(project)}<span class="toolbar-sep"></span>${iconButton("pin-project", pinnedProjects.has(project.id) ? "Unpin project" : "Pin project", { project: project.id, pinned: pinnedProjects.has(project.id) ? "1" : "0" })}${iconButton("open-project", "Open folder in Finder", { project: project.id })}${iconButton("open-terminal", "Open in Terminal", { project: project.id })}${menuButton([
        { action: "hide-project", label: hidden.has(project.id) ? "Unhide project" : "Hide project", data: { project: project.id } },
      ])}</div></div>
    ${progressMarkup(project.id)}
    <div class="detail-meta">${project.pending ? `<span class="status-label"><i class="state-dot"></i>Checking status…</span>` : `${statusMarkup(project.tiltRunning ? "running" : "stopped")}<span class="meta-item">${resources.length} resources</span><span class="meta-item">${stacks.length} stacks</span>`}<span hidden></span></div>
    ${ports ? `<div class="ports">${ports}</div>` : ""}${conflictDetails}
    ${doctorSection(project)}
    ${configSection(project)}
    ${collapsible("stacks", "Stacks & resources", `<div class="stack-list">${project.pending ? `<div class="skel-row"></div><div class="skel-row"></div>` : stackMarkup || `<div class="empty"><span class="empty-icon">T</span><strong>No resources found</strong><p>Initialize this folder with the TDK CLI to add resources.</p></div>`}</div>`, `${resources.length} total <button class="link-btn" type="button" data-action="new-stack" data-project="${esc(project.id)}">New stack</button><button class="link-btn" type="button" data-action="new-resource" data-project="${esc(project.id)}">Add resource</button>`)}
  </div>`;
}

// Collapsed sections persist across launches (best effort; storage can be unavailable).
const collapsed = new Set();
function saveCollapsed() { saveState(); }

function collapsible(id, title, body, right = "") {
  const shut = collapsed.has(id);
  return `<section class="panel ${shut ? "collapsed" : ""}" data-panel="${esc(id)}"><div class="panel-head"><button class="panel-toggle" type="button" aria-expanded="${!shut}">${chevronMarkup()}<span>${esc(title)}</span></button><span class="panel-right">${right}</span></div><div class="panel-body">${body}</div></section>`;
}

function chevronMarkup() {
  return `<svg class="chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Stacks stay open across the 7-second refresh unless the user closed them.
const closedStacks = new Set();

// Keep the scroll position across the periodic refresh, but start at the top when switching pages.
let lastView;
function render() {
  const view = selectedProjectId ?? "overview";
  const scrollTop = view === lastView ? content.scrollTop : 0;
  lastView = view;
  renderSidebar();
  const selected = projects.find((project) => project.id === selectedProjectId);
  if (selected) renderDetail(selected);
  else renderOverview();
  applyCliCapability();
  decorateButtons();
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

// macOS-style activity ring: gradient stroke with round caps, rounded numerals, optional caption line.
let ringCounter = 0;
function ringMarkup({ value, text, sub = "", label = "", size = 44, stroke = Math.max(4, Math.round(size / 10)), cls = scoreClass(value), title = "" }) {
  const id = `ring-${++ringCounter}`;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = value == null ? 0 : Math.max(0, Math.min(100, value)) / 100 * circumference;
  const big = size >= 80;
  const numSize = Math.round(size * (big ? 0.3 : 0.34));
  const center = size / 2;
  const numY = sub ? center - size * 0.05 : center;
  return `<span class="ring ${cls}" style="width:${size}px;height:${size}px" ${title ? `title="${esc(title)}"` : ""} role="img" aria-label="${esc(label || text)}">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--ring-a)"/><stop offset="1" style="stop-color:var(--ring-b)"/></linearGradient></defs>
    <circle class="ring-track" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke-width="${stroke}"/>
    ${filled > 0 ? `<circle class="ring-fill" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="url(#${id})" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${filled} ${circumference}" transform="rotate(-90 ${center} ${center})"/>` : ""}
    <text class="ring-num" x="${center}" y="${numY}" dy=".35em" text-anchor="middle" font-size="${numSize}">${esc(text)}</text>${sub ? `<text class="ring-sub" x="${center}" y="${center + size * 0.2}" dy=".35em" text-anchor="middle" font-size="${Math.round(size * 0.12)}">${esc(sub)}</text>` : ""}</svg></span>`;
}

function scoreMarkup(project, size = 44) {
  const result = doctors.get(project.id);
  if (!result) return ringMarkup({ value: null, text: "…", size, cls: "none", title: "Running tdk doctor…" });
  if (result.error) return ringMarkup({ value: null, text: "—", size, cls: "none", title: `Doctor failed: ${result.error}` });
  return ringMarkup({ value: result.score, text: result.score == null ? "—" : String(result.score), size, sub: size >= 80 ? "of 100" : "", title: `Health ${result.score ?? "—"}/100 · ${result.passed} passed, ${result.warnings} warnings, ${result.failed} failed`, label: `Health ${result.score}` });
}

function gaugeCard({ value, text, sub = "", title, caption, cls }) {
  return `<div class="gauge">${ringMarkup({ value, text, size: 60, stroke: 6, cls: cls ?? scoreClass(value), label: title })}<div class="gauge-copy"><strong>${esc(title)}</strong><span>${esc(caption)}</span></div></div>`;
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
  const rerun = iconButton("doctor-refresh", "Run doctor again", { project: project.id });
  if (!result) return collapsible("doctor", "Doctor", `<div class="doctor-box">Running tdk doctor…</div>`, rerun);
  if (result.error) return collapsible("doctor", "Doctor", `<div class="doctor-box"><div class="notice show error">Doctor could not finish: ${esc(result.error)}</div></div>`, rerun);
  const issues = result.checks.filter((check) => check.status === "fail" || check.status === "warning");
  const list = issues.length ? issues.map((check) => `<div class="doctor-item ${check.status}"><strong>${esc(check.name)}</strong><span>${esc(check.message)}</span>${check.fix ? `<code>${esc(check.fix)}</code>` : ""}</div>`).join("") : `<div class="doctor-item pass"><strong>All ${result.total} checks passed</strong></div>`;
  const ask = issues.length ? inspectRow(TDK_INSPECT.doctorPrompt({ project: project.name, path: project.path, score: result.score, issues })) : "";
  return collapsible("doctor", "Doctor", `<div class="doctor-box"><div class="doctor-summary">${scoreMarkup(project, 84)}<div class="doctor-meta"><strong>${result.score ?? "—"} / 100</strong>${stackedBar(result)}<div class="legend"><span><i class="pass"></i>${result.passed} passed</span><span><i class="warning"></i>${result.warnings} warnings</span><span><i class="fail"></i>${result.failed} failed</span></div></div></div>${list}${ask}</div>`, rerun);
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

let pendingTimer = null;

async function refreshData() {
  try {
    if (!stateLoaded) await loadState();
    const cliRequest = api("/api/cli").catch(() => null).then((value) => { cli = value; if (projects.length) render(); });
    const response = await api("/api/projects?fast=1");
    void cliRequest;
    projects = response.projects || [];
    if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) selectedProjectId = null;
    render();
    // Poll quickly until every status is in, and only then start doctor runs so they don't compete for CPU.
    clearTimeout(pendingTimer);
    if (projects.some((project) => project.pending)) pendingTimer = setTimeout(refreshData, 900);
    else void loadDoctors();
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
    if (busy.has(button.dataset.project) || jobActive(button.dataset.project)) {
      button.disabled = true;
      if (button.classList.contains("icon-btn")) continue;
      if (button.dataset.action === "start" || button.dataset.action === "restart") button.textContent = button.dataset.action === "start" ? "Starting…" : "Restarting…";
      else button.textContent = "Stopping…";
    }
  }
}

let fixingDocker = false;
const DISK_COMMANDS = ["Commands you can run in Terminal to free space:", "  docker system prune -af        # unused images and build cache (needs Docker running)", "  npm cache clean --force", "  bun pm cache rm", "  brew cleanup -s", "  rm -rf ~/Library/Caches/*"].join("\n");

async function fixDockerAndRetry(button) {
  if (fixingDocker) return;
  fixingDocker = true;
  showNotice("Restarting Docker Desktop… this usually takes 30–90 seconds. The start will continue automatically once Docker answers.", false, true);
  try {
    const result = await api("/api/docker/restart", { method: "POST", body: "{}" });
    if (!result.ok) {
      return result.lowDisk
        ? showNotice(`${result.message}\n\n${DISK_COMMANDS}`, true, true, { label: "Free up space…", run: openDiskCleanup })
        : showNotice(result.message, true, true);
    }
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
  const crud = await handleCrud(action, project, name, button.dataset);
  if (crud) return;
  if (action === "logs") {
    const view = { project, name, owner: projects.find((entry) => entry.id === project), lines: [] };
    logView = view;
    document.querySelector("#log-title").textContent = `Recent logs · ${name}`;
    document.querySelector("#log-body").textContent = "Loading…";
    renderLogAi();
    document.querySelector("#logs").showModal();
    try {
      const result = await api(`/api/logs?project=${encodeURIComponent(project)}&resource=${encodeURIComponent(name)}`);
      if (logView !== view) return;
      view.lines = (result.lines || []).map((line) => line.text || JSON.stringify(line));
      document.querySelector("#log-body").textContent = view.lines.join("\n") || "No recent logs.";
      renderLogAi();
    } catch (error) {
      if (logView === view) document.querySelector("#log-body").textContent = error.message;
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
  applyBusy();
  try {
    const payload = { project, operation: action, background: true };
    if (scope === "stack") payload.stack = name;
    if (scope === "resource") payload.resources = [name];
    const result = await api("/api/actions", { method: "POST", body: JSON.stringify(payload) });
    if (result.job) {
      jobsByProject.set(project, result.job);
      startJobPolling();
    }
  } catch (error) {
    if (error.code === "docker_unavailable") {
      // Offer to fix Docker and then carry on with the original action.
      showNotice(error.lowDisk ? `${error.message}\n\n${DISK_COMMANDS}` : error.message, true, true, error.lowDisk
        ? { label: "Free up space…", run: openDiskCleanup }
        : { label: "Restart Docker and continue", run: () => fixDockerAndRetry(button) });
    } else showNotice(error.message, true);
  } finally {
    busy.delete(project);
    render();
  }
}

// ---------- Background start / stop progress ----------
const jobsByProject = new Map();
const announced = new Set();
let jobTimer = null;
const ACTIVE = new Set(["running", "settling"]);

function jobActive(projectId) {
  return ACTIVE.has(jobsByProject.get(projectId)?.state);
}

function formatElapsed(ms) {
  if (ms == null) return "";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function progressMarkup(projectId, compact = false) {
  const job = jobsByProject.get(projectId);
  if (!job || !ACTIVE.has(job.state)) return "";
  const progress = job.progress;
  const verb = { start: "Starting", stop: "Stopping", restart: "Restarting" }[job.operation] || "Working";
  const percent = progress ? progress.percent : null;
  const step = progress ? progress.step : job.operation === "stop" ? "Stopping containers" : "Waiting for Tilt to report";
  const label = `${verb}${percent != null ? ` · ${percent}%` : "…"}`;
  return `<div class="job-progress ${compact ? "compact" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${percent != null ? `aria-valuenow="${percent}"` : ""} aria-label="${esc(label)}">
    <div class="job-head"><strong>${esc(label)}</strong><span>${esc(step)}${job.elapsedMs != null ? ` · ${formatElapsed(job.elapsedMs)}` : ""}</span></div>
    <div class="job-track ${percent == null ? "indeterminate" : ""}"><i style="width:${percent ?? 30}%"></i></div>
  </div>`;
}

async function pollJobs() {
  try {
    const { jobs } = await api("/api/jobs");
    const seen = new Set();
    for (const job of jobs) {
      seen.add(job.project);
      const before = jobsByProject.get(job.project);
      jobsByProject.set(job.project, job);
      const name = projects.find((entry) => entry.id === job.project)?.name || "Project";
      const key = `${job.project}:${job.id ?? "external"}:${job.state}`;
      if (!ACTIVE.has(job.state) && before && ACTIVE.has(before.state) && !announced.has(key)) {
        announced.add(key);
        if (job.state === "failed") showNotice(`${name}: ${job.message || "the action failed."}`, true);
        else showNotice(`${name}: ${job.progress?.percent === 100 ? "all resources are ready." : job.message || "done."}`);
        void refreshData();
      }
    }
    for (const projectId of [...jobsByProject.keys()]) if (!seen.has(projectId)) jobsByProject.delete(projectId);
  } catch {}
  render();
  if ([...jobsByProject.values()].some((job) => ACTIVE.has(job.state))) jobTimer = setTimeout(pollJobs, 1500);
  else jobTimer = null;
}

function startJobPolling() {
  clearTimeout(jobTimer);
  jobTimer = setTimeout(pollJobs, 300);
  render();
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

// The switch lives at the top of the logs dialog. Turning it on or off applies to every panel.
function renderLogAi() {
  const view = logView;
  const prompt = aiInspect && view?.lines.length ? TDK_INSPECT.logsPrompt({ project: view.owner?.name || view.project, path: view.owner?.path || "", resource: view.name, lines: view.lines }) : "";
  document.querySelector("#log-ai").innerHTML = `<div class="ai-switch-row"><label class="ai-switch"><input type="checkbox" id="ai-inspect-toggle" ${aiInspect ? "checked" : ""}><span>Inspect with AI</span></label><span class="ai-hint">${aiInspect ? "Links open your AI chat with this output pasted in. Nothing is sent until you click one." : "Off. Logs are not sent to any AI service, and the Inspect buttons are hidden."}</span></div>${prompt ? inspectRow(prompt) : ""}`;
}

function setAiInspect(on) {
  aiInspect = on;
  saveState();
  renderLogAi();
  render();
}

document.querySelector("#log-ai").addEventListener("change", (event) => {
  if (event.target.id === "ai-inspect-toggle") setAiInspect(event.target.checked);
});
refreshData();
setInterval(refreshData, 7000);
setTimeout(pollJobs, 1200);
setInterval(() => { if (!jobTimer) void pollJobs(); }, 15000);

// Sidebar: collapse the whole sidebar (button or Cmd+B) and the Workspaces list.
const appShell = document.querySelector(".app");
function applySidebarState() {
  appShell.classList.toggle("rail", collapsed.has("side"));
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

// ---------- Create / update actions (all go through the TDK CLI on the server) ----------
const KEBAB = /^[a-z][a-z0-9-]{0,62}$/;
let meta = null;
async function loadMeta() {
  if (!meta) meta = await api("/api/meta").catch(() => ({ defaultParent: "~", templates: [], resourceTypes: ["backend", "frontend", "worker", "mcp", "bring-your-own", "sdk"] }));
  return meta;
}

const formDialog = document.querySelector("#form-dialog");

function fieldMarkup(field) {
  const id = `f-${field.name}`;
  const hint = field.hint ? `<small>${esc(field.hint)}</small>` : "";
  if (field.type === "select") return `<label class="field" for="${id}">${esc(field.label)}<select id="${id}" name="${esc(field.name)}">${field.options.map((option) => `<option value="${esc(option.value)}" ${option.value === field.value ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select>${hint}</label>`;
  if (field.type === "note") return `<pre class="form-note">${esc(field.value)}</pre>`;
  if (field.type === "checks") return `<div class="field">${esc(field.label)}<div class="checks">${field.options.length ? field.options.map((option) => { const o = typeof option === "string" ? { value: option, label: option } : option; return `<label ${o.disabled ? 'class="disabled"' : ""}><input type="checkbox" name="${esc(field.name)}" value="${esc(o.value)}" ${o.disabled ? "disabled" : ""}> <span>${esc(o.label)}${o.note ? `<small>${esc(o.note)}</small>` : ""}</span></label>`; }).join("") : "<span>Nothing here yet.</span>"}</div>${hint}</div>`;
  return `<label class="field" for="${id}">${esc(field.label)}<input id="${id}" name="${esc(field.name)}" type="${field.type === "number" ? "number" : "text"}" value="${esc(field.value ?? "")}" placeholder="${esc(field.placeholder ?? "")}" autocomplete="off" spellcheck="false" ${field.list ? `list="${id}-list"` : ""}>${field.list ? `<datalist id="${id}-list">${field.list.map((item) => `<option value="${esc(item)}"></option>`).join("")}</datalist>` : ""}${hint}</label>`;
}

function openForm({ title, intro = "", fields, submit, validate, run }) {
  formDialog.innerHTML = `<form class="form" novalidate>
    <div class="modal-head"><h2>${esc(title)}</h2><button class="button quiet" type="button" data-close>Close</button></div>
    <div class="form-body">${intro ? `<p class="form-intro">${esc(intro)}</p>` : ""}${fields.map(fieldMarkup).join("")}<div class="form-error" role="alert" hidden></div><pre class="form-output" hidden></pre></div>
    <div class="form-foot"><button class="button" type="button" data-close>Cancel</button><button class="button primary" type="submit">${esc(submit)}</button></div></form>`;
  const form = formDialog.querySelector("form");
  const errorBox = form.querySelector(".form-error");
  const output = form.querySelector(".form-output");
  const submitButton = form.querySelector('[type="submit"]');
  let finished = false;
  const fail = (message) => { errorBox.textContent = message; errorBox.hidden = false; };
  for (const close of form.querySelectorAll("[data-close]")) close.addEventListener("click", () => formDialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (finished) return formDialog.close();
    errorBox.hidden = true;
    const values = {};
    for (const field of fields) {
      if (field.type === "note") continue;
      if (field.type === "checks") values[field.name] = [...form.querySelectorAll(`[name="${field.name}"]:checked`)].map((input) => input.value);
      else values[field.name] = form.elements[field.name].value.trim();
    }
    const problem = validate?.(values);
    if (problem) return fail(problem);
    submitButton.disabled = true;
    submitButton.textContent = "Working…";
    try {
      const result = await run(values);
      output.textContent = result.output || (result.ok ? "Done." : "TDK reported a problem.");
      output.hidden = false;
      if (result.ok) {
        finished = true;
        submitButton.textContent = "Done";
        await refreshData();
      } else {
        fail(result.timedOut ? "TDK did not finish in time." : "TDK could not complete this action. Details below.");
        submitButton.textContent = submit;
      }
    } catch (error) {
      fail(error.message);
      submitButton.textContent = submit;
    } finally {
      submitButton.disabled = false;
    }
  });
  formDialog.showModal();
  form.querySelector("input, select")?.focus();
}

const kebabProblem = (label, value) => (KEBAB.test(value) ? "" : `${label} must be lowercase letters, numbers and dashes, starting with a letter (for example my-api).`);
const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body) });

async function handleCrud(action, projectId, name, dataset) {
  const project = projects.find((entry) => entry.id === projectId);
  if (action === "toggle-hidden") { showHidden = !showHidden; render(); return true; }
  if (action === "pin-project" && projectId) {
    if (pinnedProjects.has(projectId)) pinnedProjects.delete(projectId); else pinnedProjects.add(projectId);
    saveState();
    render();
    return true;
  }
  if (action === "pin-resource" && projectId && name) {
    const key = `${projectId}/${name}`;
    if (pinnedResources.has(key)) pinnedResources.delete(key); else pinnedResources.add(key);
    saveState();
    render();
    return true;
  }
  if (action === "hide-project" && project) {
    if (hidden.has(project.id)) hidden.delete(project.id); else { hidden.add(project.id); selectedProjectId = null; }
    saveHidden();
    render();
    return true;
  }
  if (action === "new-project") { await openNewProject(); return true; }
  if (action === "build-with-ai") { openBuildWithAi(); return true; }
  if (action === "config-regenerate" || action === "config-verify") {
    await runConfig(projectId, action === "config-regenerate" ? "regenerate" : "verify");
    return true;
  }
  if (!project) return false;
  const stackNames = [...new Set((project.stacks || []).map((stack) => stack.name).filter(Boolean))];
  if (action === "new-resource") {
    const info = await loadMeta();
    openForm({
      title: `Add resource · ${project.name}`,
      intro: "Creates a new service from a TDK template using tdk resource.",
      fields: [
        { name: "name", label: "Name", placeholder: "my-api", hint: "Lowercase, dashes allowed." },
        { name: "type", label: "Type", type: "select", value: "backend", options: info.resourceTypes.map((type) => ({ value: type, label: type })) },
        { name: "stack", label: "Stack (optional)", placeholder: "default", list: stackNames },
        { name: "framework", label: "Framework (optional)", placeholder: "hono, react, …" },
        { name: "port", label: "Port (optional)", type: "number", hint: "Leave empty to use the next free port." },
      ],
      submit: "Create resource",
      validate: (v) => kebabProblem("Name", v.name) || (v.stack && kebabProblem("Stack", v.stack)) || (v.framework && kebabProblem("Framework", v.framework)) || "",
      run: (v) => post("/api/resources", { project: projectId, name: v.name, type: v.type, stack: v.stack || undefined, framework: v.framework || undefined, port: v.port ? Number(v.port) : undefined }),
    });
    return true;
  }
  if (action === "new-stack") {
    openForm({
      title: `New stack · ${project.name}`,
      intro: "Groups resources into a stack using tdk stack.",
      fields: [
        { name: "name", label: "Stack name", placeholder: "core" },
        { name: "resources", label: "Resources", type: "checks", options: (project.resources || []).map((resource) => resource.name) },
      ],
      submit: "Create stack",
      validate: (v) => kebabProblem("Stack name", v.name) || (v.resources.length ? "" : "Pick at least one resource."),
      run: (v) => post("/api/stacks", { project: projectId, name: v.name, resources: v.resources }),
    });
    return true;
  }
  if (action === "move-resource") {
    openForm({
      title: `Move ${name}`,
      intro: `Currently in ${dataset.stack || "no stack"}. Pick an existing stack or type a new name.`,
      fields: [{ name: "stack", label: "Stack", value: dataset.stack || "", placeholder: "core", list: stackNames }],
      submit: "Move resource",
      validate: (v) => kebabProblem("Stack", v.stack),
      run: (v) => post("/api/stacks", { project: projectId, name: v.stack, resources: [name] }),
    });
    return true;
  }
  return false;
}

async function openNewProject() {
  const info = await loadMeta();
  openForm({
    title: "New project",
    intro: "Runs tdk project to create a blank project or clone a starter template.",
    fields: [
      { name: "name", label: "Folder name", placeholder: "my-shop" },
      { name: "template", label: "Template", type: "select", value: "", options: [{ value: "", label: "Blank project" }, ...info.templates.map((template) => ({ value: template, label: template }))] },
      { name: "parent", label: "Create inside", value: info.defaultParent, list: info.roots, hint: "A folder inside your home directory. ~ means your home folder." },
    ],
    submit: "Create project",
    validate: (v) => kebabProblem("Folder name", v.name) || (v.parent ? "" : "Choose a folder."),
    run: async (v) => {
      const result = await post("/api/projects/create", { name: v.name, template: v.template || undefined, parent: v.parent });
      if (result.ok && result.project) selectedProjectId = result.project.id;
      return result;
    },
  });
}

document.querySelector("#new-project-nav").addEventListener("click", () => openNewProject());

// Asks which AI chat to open. Each link carries the TDK starter prompt (inspect.js), so nothing about the local machine is sent.
function openBuildWithAi() {
  const links = TDK_INSPECT.providerLinks(TDK_INSPECT.buildPrompt()).map((link) => `<a class="ai-btn" href="${esc(link.href)}" target="_blank" rel="noreferrer noopener" style="--ai: ${link.color}" title="Open ${esc(link.label)} with the TDK starter prompt"><svg viewBox="0 0 24 24" aria-hidden="true">${link.logo}</svg>${esc(link.label)}</a>`).join("");
  formDialog.innerHTML = `<div class="form">
    <div class="modal-head"><h2>Build with AI</h2><button class="button quiet" type="button" data-close>Close</button></div>
    <div class="form-body"><p class="form-intro">Pick an AI chat. It opens with a prompt that explains TDK's commands and project layout, then asks what you want to build.</p><div class="ai-row">${links}</div></div>
  </div>`;
  for (const close of formDialog.querySelectorAll("[data-close]")) close.addEventListener("click", () => formDialog.close());
  for (const link of formDialog.querySelectorAll(".ai-btn")) link.addEventListener("click", () => formDialog.close());
  formDialog.showModal();
}

async function openDiskCleanup() {
  let info;
  try { info = await api("/api/disk"); } catch (error) { return showNotice(error.message, true); }
  const mb = (value) => (value == null ? "" : value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`);
  openForm({
    title: "Free up space",
    intro: `${info.freeGb ?? "?"} GB free. Only caches and unused Docker data are listed; your projects, Downloads and Trash are never touched.`,
    fields: [
      { name: "ids", label: "Clean", type: "checks", options: info.items.map((item) => ({ value: item.id, label: `${item.label}${item.sizeMb != null ? ` · ${mb(item.sizeMb)}` : ""}`, note: item.requiresDocker && !item.available ? "Docker is not responding, so this is unavailable." : item.note, disabled: !item.available })) },
      { name: "commands", type: "note", value: DISK_COMMANDS },
    ],
    submit: "Clean selected",
    validate: (v) => (v.ids.length ? "" : "Select at least one item."),
    run: async (v) => {
      const result = await post("/api/disk/clean", { ids: v.ids });
      const lines = result.results.map((entry) => `${entry.ok ? "✓" : "✗"} ${entry.label}${entry.ok ? "" : ` — ${entry.output}`}`);
      return { ok: result.results.every((entry) => entry.ok), output: `${lines.join("\n")}\n\nFreed ${result.freedGb ?? "?"} GB · ${result.freeGb ?? "?"} GB free now.` };
    },
  });
}

// Popover menus: toggle on click, close on outside click or Escape.
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-menu]");
  for (const menu of document.querySelectorAll(".menu:not([hidden])")) if (!trigger || menu.previousElementSibling !== trigger) menu.hidden = true;
  if (trigger) { const menu = trigger.nextElementSibling; menu.hidden = !menu.hidden; event.stopPropagation(); }
  else if (event.target.closest(".menu [data-action]")) event.target.closest(".menu").hidden = true;
}, true);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") for (const menu of document.querySelectorAll(".menu")) menu.hidden = true; });

// ---------- Config & drift panel ----------
const configState = new Map(); // projectId -> { status, entries, loading, error }

async function loadConfig(projectId, { checkIfNever = false } = {}) {
  const current = configState.get(projectId) ?? {};
  if (current.loading) return;
  configState.set(projectId, { ...current, loading: true });
  try {
    const data = await api(`/api/config/log?project=${encodeURIComponent(projectId)}`);
    const never = data.status == null;
    configState.set(projectId, { status: data.status, entries: data.entries, loading: false, error: "" });
    if (never && checkIfNever) await runConfig(projectId, "verify", { quiet: true });
  } catch (error) {
    configState.set(projectId, { ...current, loading: false, error: error.message });
  }
  render();
}

async function runConfig(projectId, operation, { quiet = false } = {}) {
  const current = configState.get(projectId) ?? { entries: [] };
  configState.set(projectId, { ...current, loading: true, running: operation });
  render();
  try {
    const result = await post("/api/config", { project: projectId, operation });
    const entries = result.entry ? [result.entry, ...(current.entries ?? [])].slice(0, 50) : current.entries ?? [];
    const status = operation === "verify" && result.entry ? { ok: result.entry.ok, at: result.entry.at, exitCode: result.entry.exitCode } : current.status ?? null;
    configState.set(projectId, { status, entries, loading: false, running: null, error: "" });
    if (!quiet) showNotice(`${{ verify: "Drift check", migrate: "Migration", regenerate: "Regenerate" }[operation]} ${result.ok ? "finished" : "reported a problem"}. See the log below.`, !result.ok);
  } catch (error) {
    configState.set(projectId, { ...current, loading: false, running: null, error: error.message });
  }
  render();
}

function driftBadge(status) {
  if (!status) return `<span class="badge none">Not checked yet</span>`;
  return status.ok ? `<span class="badge good">In sync</span>` : `<span class="badge bad">Drift or error</span>`;
}

function configSection(project) {
  const state = configState.get(project.id);
  if (!state) void loadConfig(project.id, { checkIfNever: true });
  const busy = state?.loading;
  const status = state?.status ?? null;
  const entries = state?.entries ?? [];
  const when = status?.at ? new Date(status.at).toLocaleString() : "";
  const right = `<button class="link-btn" type="button" data-config="verify" data-project="${esc(project.id)}" ${busy ? "disabled" : ""}>${busy && state?.running === "verify" ? "Checking…" : "Check now"}</button><button class="link-btn" type="button" data-config="migrate" data-project="${esc(project.id)}" ${busy ? "disabled" : ""}>Migrate schema</button><button class="link-btn" type="button" data-config="regenerate" data-project="${esc(project.id)}" ${busy ? "disabled" : ""}>Regenerate</button>`;
  const log = entries.length
    ? entries.slice(0, 20).map((entry) => `<details class="log-entry ${entry.ok ? "ok" : "fail"}"><summary><span class="log-when">${esc(new Date(entry.at).toLocaleString())}</span><span class="log-action">${esc(entry.action)}</span><span class="log-exit">exit ${entry.exitCode ?? "—"}</span><span class="log-ms">${(entry.durationMs / 1000).toFixed(1)}s</span></summary><pre>${esc(entry.output || "(no output)")}</pre>${entry.ok ? "" : inspectRow(TDK_INSPECT.runPrompt({ project: project.name, path: project.path, action: entry.action, exitCode: entry.exitCode, output: entry.output }))}</details>`).join("")
    : `<div class="log-empty">No config runs yet. ${state?.error ? esc(state.error) : "Run a check to see its output here."}</div>`;
  const body = `<div class="config-box"><div class="config-summary">${driftBadge(status)}<span class="config-when">${status ? `Last checked ${esc(when)}` : busy ? "Checking…" : ""}</span></div>${state?.error && entries.length ? `<div class="notice show error">${esc(state.error)}</div>` : ""}<div class="log-title">Run log</div><div class="log-list">${log}</div></div>`;
  return collapsible("config", "Config & drift", body, right);
}

content.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-config]");
  if (!button) return;
  const { config: operation, project } = button.dataset;
  if (operation !== "verify") {
    const what = operation === "migrate" ? "Migrate every service.json to the current schema? This rewrites those files (use git to review or revert)." : "Regenerate the master config files from .tdk/project.json? This rewrites generated files (use git to review or revert).";
    if (!window.confirm(what)) return;
  }
  await runConfig(project, operation);
});

// Native app only: a light trackpad haptic when a control is pressed.
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button:not(:disabled), a, summary")) window.webkit?.messageHandlers?.haptic?.postMessage("tap");
}, { passive: true });
