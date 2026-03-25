import type { BridgeRequest, BridgeResponse } from "../shared/messages";

type AgentCommand =
  | { id: string; type: "RUN_SNIPPET"; payload: { code: string; world: "ISOLATED" | "MAIN"; snippetName?: string }; targetTabId?: number }
  | { id: string; type: "OPEN_URL"; payload: { url: string; active?: boolean }; targetTabId?: number }
  | { id: string; type: "GET_STATE"; targetTabId?: number }
  | { id: string; type: "GET_AI_STATE"; targetTabId?: number };

const BRIDGE_BASE_URL = "http://127.0.0.1:4471";
const serverStatus = document.getElementById("serverStatus");
const pollStatus = document.getElementById("pollStatus");
const lastCommand = document.getElementById("lastCommand");
const lastResult = document.getElementById("lastResult");
const logOutput = document.getElementById("logOutput");

let running = false;
let stopped = false;

function setStatus(element: HTMLElement | null, text: string, ok = false) {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("ok", ok);
  element.classList.toggle("bad", !ok);
}

function appendLog(message: string) {
  const time = new Date().toISOString();
  console.log(`[Bridge] ${time} ${message}`);
  if (logOutput) {
    logOutput.textContent = `${time} ${message}\n${logOutput.textContent}`.trim();
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BRIDGE_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function postResult(id: string, response: BridgeResponse) {
  await api(`/commands/${encodeURIComponent(id)}/result`, {
    method: "POST",
    body: JSON.stringify(response)
  });
}

async function findTargetTabId(): Promise<number | undefined> {
  const isRunnable = (url?: string) =>
    url != null &&
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("devtools://") &&
    !url.startsWith("about:");

  // All active tabs across all windows, pick most recently accessed runnable one
  const allActive = await chrome.tabs.query({ active: true });
  const best = allActive
    .filter((t) => isRunnable(t.url))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (best) return best.id;

  // Fallback: any runnable tab
  const allTabs = await chrome.tabs.query({});
  const fallback = allTabs
    .filter((t) => isRunnable(t.url))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  return fallback?.id;
}

async function runCommand(command: AgentCommand): Promise<BridgeResponse> {
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

  let request: BridgeRequest;
  if (command.type === "GET_STATE") {
    request = { type: "GET_STATE", targetTabId };
  } else if (command.type === "GET_AI_STATE") {
    request = { type: "GET_AI_STATE", targetTabId };
  } else if (command.type === "OPEN_URL") {
    request = { type: "OPEN_URL", payload: command.payload, targetTabId };
  } else {
    request = { type: "RUN_SNIPPET", payload: command.payload, targetTabId };
  }

  return chrome.runtime.sendMessage(request) as Promise<BridgeResponse>;
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
      setStatus(serverStatus as HTMLElement, "connected", true);
      if (pollStatus) pollStatus.textContent = "polling";

      const next = await api<{ command: AgentCommand | null }>("/commands/next");
      if (!next.command) {
        if (pollStatus) pollStatus.textContent = "idle";
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (lastCommand) lastCommand.textContent = `${next.command.type} ${next.command.id}`;
      appendLog(`running ${next.command.type} ${next.command.id}`);

      const response = await runCommand(next.command);
      await postResult(next.command.id, response);

      if (lastResult) lastResult.textContent = response.ok ? "ok" : response.error;
      appendLog(`completed ${next.command.id} ok=${response.ok}`);
    } catch (error) {
      setStatus(serverStatus as HTMLElement, "disconnected", false);
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
