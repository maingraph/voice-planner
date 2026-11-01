/**
 * Provider-neutral contract for a tool-calling LLM. Each adapter keeps its own native
 * message list so assistant turns (including thinking blocks) are replayed verbatim.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  id: string;
  content: string;
  isError?: boolean;
}

export type StopKind = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmStep {
  text: string;
  toolCalls: ToolCall[];
  stop: StopKind;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface LlmConversation {
  /** First call sends the user message; later calls send results of the previous tool calls. */
  next(toolResults?: ToolOutcome[]): Promise<LlmStep>;
}

export interface LlmProvider {
  /** Shown in the UI, e.g. "anthropic · claude-opus-5-5". */
  readonly label: string;
  start(system: string, tools: ToolSpec[], history: HistoryTurn[], userText: string): LlmConversation;
}
