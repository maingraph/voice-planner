import type { SessionsRepo } from "../storage/sessions-repo.js";
import { LlmUnavailableError } from "./llm-engine.js";
import type { AssistantAction, DialogueEngine } from "./types.js";

export interface ChatResponse {
  reply: string;
  actions: AssistantAction[];
  awaiting: boolean;
  /** Which engine answered: LLM label, "rules", or "rules (fallback)". */
  engine: string;
}

/**
 * Entry point for one user utterance: loads the dialogue session, runs the primary
 * engine (LLM when configured), falls back to the rule engine if the LLM is unavailable,
 * and persists history and context.
 */
export class Assistant {
  constructor(
    private readonly sessions: SessionsRepo,
    private readonly primary: DialogueEngine | null,
    private readonly fallback: DialogueEngine,
  ) {}

  get engineName(): string {
    return this.primary?.name ?? this.fallback.name;
  }

  async handle(userId: string, zone: string, text: string): Promise<ChatResponse> {
    const session = this.sessions.load(userId);
    const ctx = { userId, zone, text: text.trim(), session };

    let engine = this.primary ?? this.fallback;
    let result;
    let label = engine.name;
    try {
      result = await engine.handle(ctx);
      // Clarification state belongs to the rule engine; drop it once the LLM owns the dialogue.
      if (engine !== this.fallback) session.pending = null;
    } catch (err) {
      if (!(err instanceof LlmUnavailableError) || engine === this.fallback) throw err;
      console.warn(`[assistant] LLM unavailable, using rules: ${err.message}`);
      engine = this.fallback;
      label = `${this.fallback.name} (fallback)`;
      result = await this.fallback.handle(ctx);
    }

    const at = new Date().toISOString();
    session.history.push({ role: "user", text: ctx.text, at }, { role: "assistant", text: result.reply, at });
    if (result.focusIds.length) session.lastItemIds = result.focusIds.slice(0, 10);
    this.sessions.save(userId, session);
    return { reply: result.reply, actions: result.actions, awaiting: result.awaiting, engine: label };
  }
}
