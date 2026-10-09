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
  if (!response.ok) throw new Error(body.error || "Request failed.");
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
      <span class="row-meta resources-count" ${project.error ? `title="${esc(project.error)}"` : ""}>${project.error ? esc(project.error.slice(0, 60)) : `${(project.resources || []).length} resources${conflicts ? ` · ${conflicts} port conflicts` : ""}`}</span>
      ${actionSet(project, "project", "", true)}
    </div>`;
  }).join("");

  content.innerHTML = `<div class="content-inner">
    <div class="page-head"><div><h1>Projects</h1><p>${projects.length} local workspace${projects.length === 1 ? "" : "s"} discovered across your development folders.</p></div>
      <div class="summary"><div class="stat"><strong>${projects.length}</strong><span>Projects</span></div><div class="stat"><strong>${ready}</strong><span>Ready resources</span></div><div class="stat"><strong>${resources}</strong><span>Total resources</span></div></div></div>
    <div id="notice" class="notice" role="status"></div>
    ${visible.length ? `<div class="list-head"><span>Workspace</span><span>${visible.length} shown</span></div><section class="project-table" aria-label="TDK projects">${rows}</section>` : `<div class="empty"><span class="empty-icon">⌕</span><strong>${projects.length ? "No matching projects" : "No TDK projects found"}</strong><p>${projects.length ? "Try another project name or folder path." : "TDK App searches common development folders. Add a location with --scan-root or initialize a project with tdk project."}</p></div>`}
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
    <div class="section-label"><span>Stacks & resources</span><span>${resources.length} total</span></div>
    <div class="stack-list">${stackMarkup || `<div class="empty"><span class="empty-icon">T</span><strong>No resources found</strong><p>Initialize this folder with the TDK CLI to add resources.</p></div>`}</div>
  </div>`;
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
  content.scrollTop = scrollTop;
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
  } catch (error) {
    content.innerHTML = `<div class="content-inner"><div class="empty"><span class="empty-icon">!</span><strong>Couldn’t load projects</strong><p>${esc(error.message)}</p><button class="button" type="button" id="retry">Try again</button></div></div>`;
    document.querySelector("#retry")?.addEventListener("click", refreshData);
  }
}

function showNotice(message, isError = false) {
  const noticeElement = document.querySelector("#notice");
  if (!noticeElement) return;
  noticeElement.textContent = message;
  noticeElement.classList.toggle("error", isError);
  noticeElement.classList.add("show");
  setTimeout(() => noticeElement.classList.remove("show"), 6500);
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

  button.disabled = true;
  try {
    const payload = { project, operation: action };
    if (scope === "stack") payload.stack = name;
    if (scope === "resource") payload.resources = [name];
    const result = await api("/api/actions", { method: "POST", body: JSON.stringify(payload) });
    showNotice(result.message || `${action[0].toUpperCase()}${action.slice(1)} requested.`);
    setTimeout(refreshData, 500);
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
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
