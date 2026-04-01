// src/bridge/index.ts
var BRIDGE_BASE_URL = "http://127.0.0.1:4471";
var serverStatus = document.getElementById("serverStatus");
var pollStatus = document.getElementById("pollStatus");
var lastCommand = document.getElementById("lastCommand");
var lastResult = document.getElementById("lastResult");
var logOutput = document.getElementById("logOutput");
var running = false;
var stopped = false;
function setStatus(element, text, ok = false) {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("ok", ok);
  element.classList.toggle("bad", !ok);
}
function appendLog(message) {
  const time = (/* @__PURE__ */ new Date()).toISOString();
  console.log(`[Bridge] ${time} ${message}`);
  if (logOutput) {
    logOutput.textContent = `${time} ${message}
${logOutput.textContent}`.trim();
  }
}
async function api(path, init) {
  const response = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...init?.headers ?? {}
    },
    ...init
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}
async function postResult(id, response) {
  await api(`/commands/${encodeURIComponent(id)}/result`, {
    method: "POST",
    body: JSON.stringify(response)
  });
}
async function findTargetTabId() {
  const isRunnable = (url) => url != null && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("devtools://") && !url.startsWith("about:");
  const allActive = await chrome.tabs.query({ active: true });
  const best = allActive.filter((t) => isRunnable(t.url)).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (best) return best.id;
  const allTabs = await chrome.tabs.query({});
  const fallback = allTabs.filter((t) => isRunnable(t.url)).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  return fallback?.id;
}
async function runCommand(command) {
  let targetTabId = command.targetTabId;
  if (!targetTabId) {
    try {
      targetTabId = await findTargetTabId();
      appendLog(`targetTabId resolved (auto): ${targetTabId}`);
    } catch (e) {
      appendLog(`findTargetTabId error: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    appendLog(`targetTabId used (explicit): ${targetTabId}`);
  }
  let request;
  if (command.type === "GET_STATE") {
    request = { type: "GET_STATE", targetTabId };
  } else if (command.type === "GET_AI_STATE") {
    request = { type: "GET_AI_STATE", targetTabId };
  } else if (command.type === "OPEN_URL") {
    request = { type: "OPEN_URL", payload: command.payload, targetTabId, queue: command.queue };
  } else {
    request = { type: "RUN_SNIPPET", payload: command.payload, targetTabId };
  }
  return chrome.runtime.sendMessage(request);
}
async function pollLoop() {
  console.log("[Bridge] pollLoop started");
  if (running || stopped) {
    console.log("[Bridge] pollLoop already running or stopped", { running, stopped });
    return;
  }
  running = true;
  appendLog("poll loop started");
  while (!stopped) {
    try {
      setStatus(serverStatus, "connected", true);
      if (pollStatus) pollStatus.textContent = "polling";
      const next = await api("/commands/next");
      if (!next.command) {
        if (pollStatus) pollStatus.textContent = "idle";
        await new Promise((resolve) => setTimeout(resolve, 1e3));
        continue;
      }
      if (lastCommand) lastCommand.textContent = `${next.command.type} ${next.command.id}`;
      appendLog(`running ${next.command.type} ${next.command.id}`);
      const response = await runCommand(next.command);
      await postResult(next.command.id, response);
      if (lastResult) lastResult.textContent = response.ok ? "ok" : response.error;
      appendLog(`completed ${next.command.id} ok=${response.ok}`);
    } catch (error) {
      setStatus(serverStatus, "disconnected", false);
      if (pollStatus) pollStatus.textContent = "waiting";
      appendLog(`bridge error: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
window.addEventListener("beforeunload", () => {
  stopped = true;
});
void pollLoop();
