import { DateTime } from "luxon";
import { Assistant } from "./agent/assistant.js";
import { LlmEngine } from "./agent/llm-engine.js";
import type { AppConfig } from "./config/config.js";
import { PlannerService, type Clock } from "./domain/planner-service.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.js";
import type { LlmProvider } from "./llm/provider.js";
import { RuleEngine } from "./nlu/rule-engine.js";
import { OpenAiCompatibleEmbedder } from "./search/embeddings.js";
import { SearchEngine } from "./search/search-engine.js";
import { openDb } from "./storage/db.js";
import { ItemsRepo } from "./storage/items-repo.js";
import { SessionsRepo } from "./storage/sessions-repo.js";
import { SpeechToText } from "./voice/stt.js";

export interface AppServices {
  config: AppConfig;
  planner: PlannerService;
  sessions: SessionsRepo;
  assistant: Assistant;
  stt: SpeechToText | null;
  semanticSearch: boolean;
}

function makeProvider(config: AppConfig): LlmProvider | null {
  const llm = config.llm;
  if (llm.kind === "anthropic") return new AnthropicProvider({ apiKey: llm.apiKey, baseURL: llm.baseURL, model: llm.model, effort: llm.effort });
  if (llm.kind === "openai") return new OpenAiCompatibleProvider(llm);
  return null;
}

/** Composition root: wires storage → search → domain → dialogue engines. */
export function buildServices(config: AppConfig, overrides: { clock?: Clock; provider?: LlmProvider | null } = {}): AppServices {
  const db = openDb(config.dbFile);
  const items = new ItemsRepo(db);
  const sessions = new SessionsRepo(db);
  const embedder = config.embeddings ? new OpenAiCompatibleEmbedder(config.embeddings.baseUrl, config.embeddings.apiKey, config.embeddings.model) : null;
  const search = new SearchEngine(embedder);
  const planner = new PlannerService(items, search, overrides.clock ?? (() => DateTime.now()));
  const rules = new RuleEngine(planner);
  const provider = overrides.provider !== undefined ? overrides.provider : makeProvider(config);
  const primary = provider ? new LlmEngine(provider, planner) : null;
  const assistant = new Assistant(sessions, primary, rules);
  const stt = config.stt ? new SpeechToText(config.stt.baseUrl, config.stt.apiKey, config.stt.model) : null;
  return { config, planner, sessions, assistant, stt, semanticSearch: search.semantic };
}
