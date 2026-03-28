import { HISTORY_LIMIT, STORAGE_KEYS } from "../shared/constants";
import type { BridgeRequest, BridgeResponse } from "../shared/messages";
import type {
  CapturedLog,
  ExecutionWorld,
  ExtensionState,
  RunResultEnvelope,
  SavedSnippet,
  SerializedError
} from "../shared/types";
import { collectAIState } from "./ai-state-collector";

const BRIDGE_BASE_URL = "http://127.0.0.1:4471";
const BRIDGE_POLL_ALARM = "bridge-poll";
let pollInFlight = false;

chrome.runtime.onInstalled.addListener(() => {
  void ensureBridgeTab();
  void ensurePolling();
  void pollServerOnce();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureBridgeTab();
  void ensurePolling();
  void pollServerOnce();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_POLL_ALARM) {
    void pollServerOnce();
  }
});

async function ensureBridgeTab() {
  console.log("[Background] ensureBridgeTab called");
  const bridgeUrl = chrome.runtime.getURL("bridge.html");
  const tabs = await chrome.tabs.query({ url: bridgeUrl });
  if (tabs.length > 0) {
    console.log("[Background] Bridge tab already exists");
    return;
  }

  try {
    await chrome.tabs.create({ url: bridgeUrl, active: false });
    console.log("[Background] Bridge tab created successfully");
  } catch (error) {
    console.error("[Background] Failed to create bridge tab:", error);
  }
}

async function ensurePolling() {
  try {
    await chrome.alarms.create(BRIDGE_POLL_ALARM, { periodInMinutes: 0.1 });
  } catch (error) {
    console.error("[Background] Failed to create bridge poll alarm:", error);
  }
}

chrome.runtime.onMessage.addListener((message: BridgeRequest, sender, sendResponse) => {
  console.log("[Background] Received message:", message.type, "from:", sender.url);
  void ensureBridgeTab();
  void ensurePolling();
  void executeBridgeRequest(message).then(sendResponse);
  return true;
});

async function executeBridgeRequest(message: BridgeRequest): Promise<BridgeResponse> {
  console.log("[Background] handleMessage processing:", message.type);
  try {
    switch (message.type) {
      case "GET_STATE":
        return { ok: true, state: await getExtensionState(message.targetTabId) };
      case "GET_AI_STATE": {
        console.log("[Background] Handling GET_AI_AI_STATE for tab:", message.targetTabId);
        const tab = message.targetTabId ? await chrome.tabs.get(message.targetTabId) : await getActiveTab();
        if (!tab.id) throw new Error("No active tab.");
        const aiState = await collectAIState(tab.id);
        return { ok: true, aiState };
      }
      case "OPEN_URL":
        return { ok: true, run: await openUrl(message.payload.url, message.payload.active, message.targetTabId) };
      case "RUN_SNIPPET":
        return { ok: true, run: await runSnippet(message.payload.code, message.payload.world, message.payload.snippetName, message.targetTabId) };
      case "SAVE_SNIPPET":
        return { ok: true, snippet: await saveSnippet(message.payload) };
      case "DELETE_SNIPPET":
        await deleteSnippet(message.payload.id);
        return { ok: true };
      case "SET_WARNING_ACCEPTED":
        await chrome.storage.local.set({ [STORAGE_KEYS.warningAccepted]: message.payload.accepted });
        return { ok: true };
      default:
        console.warn("[Background] Unknown message type received:", (message as any).type);
        return { ok: false, error: "Unknown message." };
    }
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

async function pollServerOnce() {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const response = await fetch(`${BRIDGE_BASE_URL}/commands/next`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const next = await response.json() as {
      ok: boolean;
      command?: (BridgeRequest & { id: string }) | null;
    };

    if (!next.command) {
      return;
    }

    console.log("[Background] Polled command from bridge server:", next.command.type, next.command.id);
    const result = await executeBridgeRequest(next.command);

    await fetch(`${BRIDGE_BASE_URL}/commands/${encodeURIComponent(next.command.id)}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    });
  } catch (error) {
    console.error("[Background] pollServerOnce failed:", error);
  } finally {
    pollInFlight = false;
  }
}

async function getExtensionState(targetTabId?: number): Promise<ExtensionState> {
  const tab = targetTabId ? await chrome.tabs.get(targetTabId) : await getActiveTab();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.snippets,
    STORAGE_KEYS.history,
    STORAGE_KEYS.warningAccepted
  ]);

  return {
    currentUrl: tab.url ?? "Unavailable",
    snippets: normalizeSnippets(stored[STORAGE_KEYS.snippets]),
    history: normalizeHistory(stored[STORAGE_KEYS.history]),
    warningAccepted: Boolean(stored[STORAGE_KEYS.warningAccepted])
  };
}

async function runSnippet(code: string, world: ExecutionWorld, snippetName?: string, targetTabId?: number): Promise<RunResultEnvelope> {
  if (!code.trim()) {
    throw new Error("Snippet is empty.");
  }

  const tab = targetTabId
    ? await chrome.tabs.get(targetTabId)
    : await getActiveTab();
  if (!tab.id) {
    throw new Error("No active tab is available.");
  }

  const startedAt = Date.now();
  const payload = await evaluateSnippetWithDebugger(tab.id, code);

  const envelope: RunResultEnvelope = {
    ok: payload.ok,
    tabId: tab.id,
    url: tab.url ?? "Unavailable",
    durationMs: Date.now() - startedAt,
    result: payload.result,
    logs: payload.logs ?? [],
    error: payload.error ?? null,
    ranAt: new Date().toISOString(),
    world,
    snippetName,
    code
  };

  await appendHistory(envelope);
  return envelope;
}

async function openUrl(url: string, _active = false, targetTabId?: number): Promise<RunResultEnvelope> {
  if (!url || !/^https?:/i.test(url)) {
    throw new Error("OPEN_URL requires an http/https URL.");
  }

  const startedAt = Date.now();
  let tab: chrome.tabs.Tab;

  // Always open in background — never steal focus from the user's active tab
  if (targetTabId) {
    tab = await chrome.tabs.update(targetTabId, { url, active: false });
  } else {
    tab = await chrome.tabs.create({ url, active: false });
  }

  const envelope: RunResultEnvelope = {
    ok: true,
    tabId: tab.id,
    url,
    durationMs: Date.now() - startedAt,
    result: { openedUrl: url, tabId: tab.id },
    logs: [],
    error: null,
    ranAt: new Date().toISOString(),
    world: "MAIN",
    snippetName: "open url",
    code: `OPEN_URL ${url}`,
  };

  await appendHistory(envelope);
  return envelope;
}

async function evaluateSnippetWithDebugger(
  tabId: number,
  code: string
): Promise<{ ok: boolean; result: unknown; logs: CapturedLog[]; error: SerializedError | null }> {
  const debuggee = { tabId };
  const expression = `
    (async () => {
      const logs = [];
      const methods = ["log", "warn", "error"];
      const originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error
      };

      const serialize = (value, seen = new WeakSet()) => {
        if (value === null || value === undefined) return value ?? null;
        const valueType = typeof value;
        if (valueType === "string" || valueType === "number" || valueType === "boolean") return value;
        if (valueType === "bigint") return { __type: "bigint", value: String(value) };
        if (valueType === "function") return { __type: "function", value: value.name || "anonymous" };
        if (valueType === "symbol") return { __type: "symbol", value: String(value) };
        if (value instanceof Error) return { __type: "error", name: value.name, message: value.message, stack: value.stack };
        if (value instanceof Element) return { __type: "element", tagName: value.tagName, id: value.id, className: value.className, text: value.textContent?.slice(0, 200) ?? "" };
        if (value instanceof NodeList || value instanceof HTMLCollection) return Array.from(value).map((item) => serialize(item, seen));
        if (Array.isArray(value)) return value.map((item) => serialize(item, seen));
        if (value instanceof Map) return { __type: "map", entries: Array.from(value.entries()).map(([key, entryValue]) => [serialize(key, seen), serialize(entryValue, seen)]) };
        if (value instanceof Set) return { __type: "set", values: Array.from(value.values()).map((item) => serialize(item, seen)) };
        if (value instanceof Date) return { __type: "date", value: value.toISOString() };
        if (typeof value === "object") {
          if (seen.has(value)) return { __type: "circular" };
          seen.add(value);
          const entries = Object.entries(value).map(([key, entryValue]) => [key, serialize(entryValue, seen)]);
          seen.delete(value);
          return Object.fromEntries(entries);
        }
        return { __type: "unserializable", value: String(value) };
      };

      const stringifyArgs = (args) =>
        args
          .map((arg) => {
            try {
              const serialized = serialize(arg);
              return typeof serialized === "string" ? serialized : JSON.stringify(serialized);
            } catch {
              return "[unserializable]";
            }
          })
          .join(" ");

      for (const method of methods) {
        console[method] = (...args) => {
          logs.push({
            level: method,
            args: serialize(args),
            text: stringifyArgs(args),
            at: new Date().toISOString()
          });
          originalConsole[method](...args);
        };
      }

      try {
        const value = await (async () => { ${code} })();
        return JSON.stringify({ ok: true, result: serialize(value), logs, error: null });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          result: null,
          logs,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          }
        });
      } finally {
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
      }
    })();
  `;

  await chrome.debugger.attach(debuggee, "1.3");

  try {
    const response = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }) as { result?: { value?: string }; exceptionDetails?: { text?: string } };

    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || "Runtime.evaluate failed");
    }

    const raw = response.result?.value;
    if (!raw || typeof raw !== "string") {
      throw new Error("Snippet evaluation returned no payload");
    }

    return JSON.parse(raw) as {
      ok: boolean;
      result: unknown;
      logs: CapturedLog[];
      error: SerializedError | null;
    };
  } finally {
    try {
      await chrome.debugger.detach(debuggee);
    } catch {
      // Ignore detach failures if Chrome already released the session.
    }
  }
}

async function saveSnippet(input: { id?: string; name: string; code: string; world: ExecutionWorld }): Promise<SavedSnippet> {
  const current = await chrome.storage.local.get(STORAGE_KEYS.snippets);
  const snippets = normalizeSnippets(current[STORAGE_KEYS.snippets]);
  const now = new Date().toISOString();

  const snippet: SavedSnippet = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name.trim(),
    code: input.code,
    world: input.world,
    createdAt: input.id ? snippets.find((item) => item.id === input.id)?.createdAt ?? now : now,
    updatedAt: now
  };

  const next = [...snippets.filter((item) => item.id !== snippet.id), snippet].sort((a, b) => a.name.localeCompare(b.name));
  await chrome.storage.local.set({ [STORAGE_KEYS.snippets]: next });
  return snippet;
}

async function deleteSnippet(id: string): Promise<void> {
  const current = await chrome.storage.local.get(STORAGE_KEYS.snippets);
  const snippets = normalizeSnippets(current[STORAGE_KEYS.snippets]).filter((item) => item.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEYS.snippets]: snippets });
}

async function appendHistory(run: RunResultEnvelope): Promise<void> {
  const current = await chrome.storage.local.get(STORAGE_KEYS.history);
  const history = normalizeHistory(current[STORAGE_KEYS.history]);
  const next = [summarizeRunForHistory(run), ...history].slice(0, HISTORY_LIMIT);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.history]: next });
  } catch (error) {
    const message = getErrorMessage(error);
    if (!/quota/i.test(message)) {
      throw error;
    }

    const compact = next.slice(0, Math.min(10, next.length)).map((entry) => ({
      ...entry,
      result: typeof entry.result === "string" ? entry.result.slice(0, 500) : { __truncated: true },
      logs: (entry.logs || []).slice(0, 3),
      code: entry.code.slice(0, 200),
    }));
    await chrome.storage.local.set({ [STORAGE_KEYS.history]: compact });
  }
}

function summarizeRunForHistory(run: RunResultEnvelope): RunResultEnvelope {
  const previewText = (value: unknown, max = 400) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw.length > max ? `${raw.slice(0, max)}…` : raw;
  };

  const summarizeResult = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    }
    try {
      const raw = JSON.stringify(value);
      if (!raw) return value;
      if (raw.length <= 2000) return value;
      return {
        __truncated: true,
        preview: `${raw.slice(0, 2000)}…`,
      };
    } catch {
      return { __truncated: true, preview: previewText(value, 2000) };
    }
  };

  return {
    ...run,
    code: run.code.length > 600 ? `${run.code.slice(0, 600)}…` : run.code,
    result: summarizeResult(run.result),
    logs: (run.logs || []).slice(0, 10).map((entry) => ({
      ...entry,
      text: entry.text.length > 500 ? `${entry.text.slice(0, 500)}…` : entry.text,
    })),
  };
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  // Query only http/https tabs — this excludes chrome://, chrome-extension://, about:, etc.
  const httpTabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"], active: true });
  const best = httpTabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (best) return best;

  // Fallback: any http/https tab
  const allHttp = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const fallback = allHttp.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];

  if (!fallback) {
    throw new Error("No runnable web tab found.");
  }

  return fallback;
}

function normalizeSnippets(value: unknown): SavedSnippet[] {
  return Array.isArray(value) ? (value as SavedSnippet[]) : [];
}

function normalizeHistory(value: unknown): RunResultEnvelope[] {
  return Array.isArray(value) ? (value as RunResultEnvelope[]) : [];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
