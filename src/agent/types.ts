import type { OccurrenceView } from "../domain/format.js";
import type { SessionState } from "../storage/sessions-repo.js";

export type ActionKind = "created" | "updated" | "deleted" | "completed" | "restored" | "listed" | "found";

/** Structured side effects of a turn — the UI renders them as cards and refreshes the agenda. */
export interface AssistantAction {
  kind: ActionKind;
  items: OccurrenceView[];
}

export interface TurnContext {
  userId: string;
  zone: string;
  text: string;
  session: SessionState;
}

export interface TurnResult {
  reply: string;
  actions: AssistantAction[];
  /** The assistant asked a clarifying question and waits for an answer. */
  awaiting: boolean;
  /** Items the turn talked about — the target of follow-ups like "перенеси её". */
  focusIds: string[];
}

export interface DialogueEngine {
  readonly name: string;
  handle(ctx: TurnContext): Promise<TurnResult>;
}
