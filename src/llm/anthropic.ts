import Anthropic from "@anthropic-ai/sdk";
import type { HistoryTurn, LlmConversation, LlmProvider, LlmStep, StopKind, ToolOutcome, ToolSpec } from "./provider.js";

export interface AnthropicOptions {
  apiKey?: string;
  baseURL?: string;
  model: string;
  effort: "low" | "medium" | "high";
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Claude via the official SDK. Uses the beta endpoint only to opt into server-side
 * refusal fallbacks ("default" routing); everything else is the regular Messages API.
 */
export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;
  readonly label: string;

  constructor(private readonly opts: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, authToken: null, baseURL: opts.baseURL, maxRetries: 2, timeout: 60_000 });
    this.label = `anthropic · ${opts.model}`;
  }

  start(system: string, tools: ToolSpec[], history: HistoryTurn[], userText: string): LlmConversation {
    const apiTools: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: "user", content: userText },
    ];
    let started = false;

    return {
      next: async (toolResults?: ToolOutcome[]): Promise<LlmStep> => {
        if (started) {
          messages.push({
            role: "user",
            content: (toolResults ?? []).map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.id,
              content: r.content,
              is_error: r.isError ?? false,
            })),
          });
        }
        started = true;

        const response = await this.client.beta.messages.create({
          model: this.opts.model,
          max_tokens: 4096,
          system,
          tools: apiTools,
          messages,
          output_config: { effort: this.opts.effort },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        });

        if (response.stop_reason === "refusal") {
          return { text: "", toolCalls: [], stop: "refusal" };
        }
        // Replay the assistant turn exactly as received (thinking blocks included).
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        const toolCalls = response.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        const stop: StopKind =
          response.stop_reason === "tool_use"
            ? "tool_use"
            : response.stop_reason === "end_turn"
              ? "end"
              : response.stop_reason === "max_tokens"
                ? "max_tokens"
                : "other";
        return { text, toolCalls, stop };
      },
    };
  }
}
