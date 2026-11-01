import { describe, expect, it } from "vitest";
import type { HistoryTurn, LlmConversation, LlmProvider, LlmStep, ToolOutcome, ToolSpec } from "../src/llm/provider.js";
import { makeApp } from "./helpers.js";

/**
 * A scripted stand-in for the LLM: each turn is a function that receives the tool results
 * of the previous step and returns the next step. Lets us test the agent loop, tool
 * validation and fallbacks deterministically without network access.
 */
type Script = Array<(results: ToolOutcome[] | undefined, ctx: { system: string; history: HistoryTurn[]; user: string }) => LlmStep>;

class FakeProvider implements LlmProvider {
  readonly label = "fake · scripted";
  systems: string[] = [];
  tools: ToolSpec[] = [];
  constructor(private readonly scripts: Script[]) {}
  start(system: string, tools: ToolSpec[], history: HistoryTurn[], userText: string): LlmConversation {
    this.systems.push(system);
    this.tools = tools;
    const script = this.scripts.shift();
    if (!script) throw new Error("no script left");
    let i = 0;
    return {
      next: async (results?: ToolOutcome[]) => script[i++](results, { system, history, user: userText }),
    };
  }
}

class BrokenProvider implements LlmProvider {
  readonly label = "broken";
  start(): LlmConversation {
    return { next: async () => Promise.reject(new Error("503 overloaded")) };
  }
}

const call = (name: string, input: unknown): LlmStep => ({ text: "", toolCalls: [{ id: `c-${name}`, name, input }], stop: "tool_use" });
const end = (text: string): LlmStep => ({ text, toolCalls: [], stop: "end" });

describe("LLM engine (tool-calling loop)", () => {
  it("exposes the planner tools with JSON schemas", () => {
    const provider = new FakeProvider([[() => end("ok")]]);
    const app = makeApp({ provider });
    return app.say("привет").then(() => {
      expect(provider.tools.map((t) => t.name)).toEqual([
        "create_item",
        "list_items",
        "search_items",
        "update_item",
        "complete_item",
        "delete_item",
        "restore_last_deleted",
      ]);
      expect(provider.tools[0].inputSchema).toMatchObject({ type: "object", required: ["type", "title"] });
    });
  });

  it("creates an item through a tool call and returns the model's reply", async () => {
    let toolResult: unknown;
    const provider = new FakeProvider([
      [
        () => call("create_item", { type: "reminder", title: "Позвонить Ивану", date: "2026-11-05", time: "10:00" }),
        (results) => {
          toolResult = JSON.parse(results![0].content);
          return end("Хорошо, напомню завтра в 10:00 позвонить Ивану.");
        },
      ],
    ]);
    const app = makeApp({ provider });
    const r = await app.say("Напомни мне завтра в 10 утра позвонить Ивану");
    expect(r.engine).toBe("fake · scripted");
    expect(r.reply).toBe("Хорошо, напомню завтра в 10:00 позвонить Ивану.");
    expect(toolResult).toMatchObject({ status: "created", item: { when: "завтра в 10:00" } });
    expect(app.planner.allItems(app.user)).toHaveLength(1);
  });

  it("server enforces the meeting-time rule and hands the model a question", async () => {
    let result: any;
    const provider = new FakeProvider([
      [
        () => call("create_item", { type: "meeting", title: "Встреча с Иваном", date: "2026-11-05" }),
        (results) => {
          result = JSON.parse(results![0].content);
          return end(result.suggested_question);
        },
      ],
    ]);
    const app = makeApp({ provider });
    const r = await app.say("Поставь встречу с Иваном завтра");
    expect(result).toMatchObject({ status: "needs_info", missing: "time" });
    expect(r.reply).toBe("На какое время поставить встречу?");
    expect(r.awaiting).toBe(true);
    expect(app.planner.allItems(app.user)).toHaveLength(0);
  });

  it("rejects invalid tool input and lets the model recover", async () => {
    let first: ToolOutcome | undefined;
    const provider = new FakeProvider([
      [
        () => call("create_item", { type: "event", title: "" }),
        (results) => {
          first = results![0];
          return call("create_item", { type: "task", title: "Купить хлеб" });
        },
        () => end("Добавил задачу «Купить хлеб»."),
      ],
    ]);
    const app = makeApp({ provider });
    await app.say("купить хлеб");
    expect(first?.isError).toBe(true);
    expect(first?.content).toContain("Invalid input");
    expect(app.planner.allItems(app.user).map((i) => i.title)).toEqual(["Купить хлеб"]);
  });

  it("puts recently discussed items into the next system prompt (for «перенеси её»)", async () => {
    const provider = new FakeProvider([
      [() => call("create_item", { type: "meeting", title: "Встреча с дизайнером", date: "2026-11-06", time: "11:00" }), () => end("Готово.")],
      [() => end("Перенёс.")],
    ]);
    const app = makeApp({ provider });
    await app.say("В пятницу в 11 встреча с дизайнером");
    await app.say("А перенеси её на завтра");
    expect(provider.systems[1]).toMatch(/id=[0-9a-f-]{36} \| meeting \| «Встреча с дизайнером» \| послезавтра с 11:00 до 12:00/);
    expect(provider.systems[1]).toContain("2026-11-05 четверг (завтра)");
  });

  it("update_item keeps the time when only the date changes", async () => {
    const app = makeApp({
      provider: new FakeProvider([
        [() => call("create_item", { type: "meeting", title: "Встреча с дизайнером", date: "2026-11-06", time: "11:00" }), () => end("ok")],
      ]),
    });
    await app.say("В пятницу в 11 встреча с дизайнером");
    const id = app.planner.allItems(app.user)[0].id;
    const provider2 = new FakeProvider([[() => call("update_item", { id, date: "2026-11-05" }), () => end("ok")]]);
    const app2 = { ...app };
    // Re-use the same storage with a new scripted provider.
    const { LlmEngine } = await import("../src/agent/llm-engine.js");
    const { Assistant } = await import("../src/agent/assistant.js");
    const { RuleEngine } = await import("../src/nlu/rule-engine.js");
    const assistant = new Assistant(app2.sessions, new LlmEngine(provider2, app.planner), new RuleEngine(app.planner));
    const r = await assistant.handle(app.user, "Europe/Moscow", "перенеси её на завтра");
    expect(r.actions[0].items[0]).toMatchObject({ start: "2026-11-05T11:00:00", end: "2026-11-05T12:00:00" });
  });

  it("falls back to the rule engine when the LLM is unavailable", async () => {
    const app = makeApp({ provider: new BrokenProvider() });
    const r = await app.say("Напомни мне завтра в 10 утра позвонить Ивану");
    expect(r.engine).toBe("rules (fallback)");
    expect(r.reply).toBe("Хорошо, напомню завтра в 10:00: позвонить Ивану.");
  });

  it("does not repeat side effects if the LLM fails after changing data", async () => {
    const provider = new FakeProvider([
      [
        () => call("create_item", { type: "task", title: "Купить хлеб" }),
        () => {
          throw new Error("connection reset");
        },
      ],
    ]);
    const app = makeApp({ provider });
    const r = await app.say("купить хлеб");
    expect(r.reply).toContain("Добавлено: «Купить хлеб»");
    expect(app.planner.allItems(app.user)).toHaveLength(1);
  });
});
