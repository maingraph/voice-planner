import type { PlannerService } from "../domain/planner-service.js";
import type { HistoryTurn, LlmProvider, ToolOutcome } from "../llm/provider.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_SPECS, ToolExecutor } from "./tools.js";
import type { AssistantAction, DialogueEngine, TurnContext, TurnResult } from "./types.js";

const MAX_STEPS = 8;
const HISTORY_TURNS = 12;

/** Raised when the LLM failed before changing any data, so a fallback engine can safely retry. */
export class LlmUnavailableError extends Error {}

/**
 * Tool-calling agent: the LLM understands the request and decides which planner
 * operations to run; all data access goes through ToolExecutor → PlannerService.
 */
export class LlmEngine implements DialogueEngine {
  readonly name: string;

  constructor(
    private readonly provider: LlmProvider,
    private readonly planner: PlannerService,
  ) {
    this.name = provider.label;
  }

  async handle(ctx: TurnContext): Promise<TurnResult> {
    const system = buildSystemPrompt(this.planner, ctx.userId, ctx.zone, ctx.session);
    const conversation = this.provider.start(system, TOOL_SPECS, recentHistory(ctx), ctx.text);
    const executor = new ToolExecutor(this.planner, ctx.userId, ctx.zone, ctx.session, ctx.text);

    try {
      let step = await conversation.next();
      for (let i = 0; i < MAX_STEPS && step.stop === "tool_use" && step.toolCalls.length; i++) {
        const outcomes: ToolOutcome[] = [];
        for (const call of step.toolCalls) {
          const res = await executor.run(call.name, call.input);
          outcomes.push({ id: call.id, content: res.content, isError: res.isError });
        }
        step = await conversation.next(outcomes);
      }
      if (step.stop === "refusal") return finish("С этим я помочь не могу, но могу вести задачи, напоминания и встречи.", executor, false);
      const reply = step.text || summarize(executor.actions) || "Готово.";
      return finish(reply, executor, /\?\s*$/.test(reply));
    } catch (err) {
      if (!executor.mutated) throw new LlmUnavailableError((err as Error).message);
      // Data already changed: report what happened instead of re-running the request elsewhere.
      console.error("[llm] failed after mutations:", err);
      return finish(summarize(executor.actions) || "Готово.", executor, false);
    }
  }
}

function finish(reply: string, executor: ToolExecutor, awaiting: boolean): TurnResult {
  return { reply, actions: executor.actions, awaiting, focusIds: executor.focusIds };
}

/** Plain text history; tool traffic of past turns is represented by "recent items" in the prompt. */
function recentHistory(ctx: TurnContext): HistoryTurn[] {
  const turns = ctx.session.history.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, text: t.text }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

function summarize(actions: AssistantAction[]): string {
  const verbs: Record<string, string> = { created: "Добавлено", updated: "Изменено", deleted: "Удалено", completed: "Отмечено", restored: "Восстановлено" };
  return actions
    .filter((a) => a.kind in verbs)
    .map((a) => `${verbs[a.kind]}: ${a.items.map((i) => `«${i.title}», ${i.when}`).join("; ")}.`)
    .join(" ");
}
