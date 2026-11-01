import type { HistoryTurn, LlmConversation, LlmProvider, LlmStep, ToolOutcome, ToolSpec } from "./provider.js";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Short name for the UI: "openai", "openrouter", "yandex", "ollama"… */
  vendor: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Any server speaking the OpenAI Chat Completions protocol with function calling:
 * OpenAI, OpenRouter, Groq, YandexGPT (OpenAI-compatible API), local Ollama / vLLM.
 * Lets the prototype run with whichever provider is available to the reviewer.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly label: string;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.label = `${opts.vendor} · ${opts.model}`;
  }

  start(system: string, tools: ToolSpec[], history: HistoryTurn[], userText: string): LlmConversation {
    const apiTools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: "user", content: userText },
    ];
    let started = false;

    return {
      next: async (toolResults?: ToolOutcome[]): Promise<LlmStep> => {
        if (started) {
          for (const r of toolResults ?? []) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
        }
        started = true;
        const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({ model: this.opts.model, messages, tools: apiTools, tool_choice: "auto" }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const json = (await res.json()) as {
          choices: { message: ChatMessage; finish_reason: string }[];
        };
        const choice = json.choices[0];
        const msg = choice.message;
        messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
        const toolCalls = (msg.tool_calls ?? []).map((c) => {
          let input: unknown = {};
          try {
            input = JSON.parse(c.function.arguments || "{}");
          } catch {
            input = { __invalid_json: c.function.arguments };
          }
          return { id: c.id, name: c.function.name, input };
        });
        const stop = toolCalls.length ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end";
        return { text: (msg.content ?? "").trim(), toolCalls, stop };
      },
    };
  }
}
