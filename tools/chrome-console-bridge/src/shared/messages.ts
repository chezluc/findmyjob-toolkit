import type { RunResultEnvelope, RunSnippetRequest, SavedSnippet } from "./types";
import type { AIState } from "./ai-state";

export type BridgeRequest =
  | { type: "GET_STATE"; targetTabId?: number }
  | { type: "GET_AI_STATE"; targetTabId?: number }
  | { type: "OPEN_URL"; payload: { url: string; active?: boolean }; targetTabId?: number }
  | { type: "RUN_SNIPPET"; payload: RunSnippetRequest; targetTabId?: number }
  | { type: "SAVE_SNIPPET"; payload: { id?: string; name: string; code: string; world: "ISOLATED" | "MAIN" } }
  | { type: "DELETE_SNIPPET"; payload: { id: string } }
  | { type: "SET_WARNING_ACCEPTED"; payload: { accepted: boolean } };

export type BridgeResponse =
  | { ok: true; state: { currentUrl: string; snippets: SavedSnippet[]; history: RunResultEnvelope[]; warningAccepted: boolean } }
  | { ok: true; aiState: AIState }
  | { ok: true; run: RunResultEnvelope }
  | { ok: true; snippet: SavedSnippet }
  | { ok: true }
  | { ok: false; error: string };
