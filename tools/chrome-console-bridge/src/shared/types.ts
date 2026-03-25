export type ExecutionWorld = "ISOLATED" | "MAIN";

export type LogLevel = "log" | "warn" | "error";

export interface CapturedLog {
  level: LogLevel;
  args: unknown[];
  text: string;
  at: string;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export interface RunResultEnvelope {
  ok: boolean;
  tabId?: number;
  url: string;
  durationMs: number;
  result: unknown;
  logs: CapturedLog[];
  error: SerializedError | null;
  ranAt: string;
  world: ExecutionWorld;
  snippetName?: string;
  code: string;
}

export interface SavedSnippet {
  id: string;
  name: string;
  code: string;
  world: ExecutionWorld;
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionState {
  currentUrl: string;
  snippets: SavedSnippet[];
  history: RunResultEnvelope[];
  warningAccepted: boolean;
}

export interface RunSnippetRequest {
  code: string;
  world: ExecutionWorld;
  snippetName?: string;
}
