import "dotenv/config";
import path from "node:path";
import { safeZone } from "../domain/time.js";

const env = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

export type LlmConfig =
  | { kind: "anthropic"; apiKey: string; baseURL?: string; model: string; effort: "low" | "medium" | "high" }
  | { kind: "openai"; baseUrl: string; apiKey: string; model: string; vendor: string }
  | { kind: "none" };

export interface AppConfig {
  port: number;
  host: string;
  dbFile: string;
  defaultZone: string;
  llm: LlmConfig;
  embeddings: { baseUrl: string; apiKey: string; model: string } | null;
  stt: { baseUrl: string; apiKey: string; model: string } | null;
}

function llmConfig(): LlmConfig {
  const wanted = (env("LLM_PROVIDER") ?? "auto").toLowerCase();
  const anthropicKey = env("ANTHROPIC_API_KEY");
  const openaiKey = env("LLM_API_KEY") ?? env("OPENAI_API_KEY");
  const effort = (env("LLM_EFFORT") ?? "low") as "low" | "medium" | "high";

  if ((wanted === "auto" || wanted === "anthropic") && anthropicKey) {
    return { kind: "anthropic", apiKey: anthropicKey, baseURL: env("ANTHROPIC_BASE_URL"), model: env("ANTHROPIC_MODEL") ?? "claude-opus-5-5", effort };
  }
  if ((wanted === "auto" || wanted === "openai") && openaiKey) {
    const model = env("LLM_MODEL");
    if (!model) {
      console.warn("[config] LLM_API_KEY is set but LLM_MODEL is empty — running without LLM.");
      return { kind: "none" };
    }
    const baseUrl = env("LLM_BASE_URL") ?? "https://api.openai.com/v1";
    const vendor = env("LLM_VENDOR") ?? new URL(baseUrl).hostname.replace(/^api\./, "").split(".")[0];
    return { kind: "openai", baseUrl, apiKey: openaiKey, model, vendor };
  }
  return { kind: "none" };
}

export function loadConfig(): AppConfig {
  const dataDir = env("DATA_DIR") ?? path.resolve("data");
  const embKey = env("EMBEDDINGS_API_KEY") ?? env("OPENAI_API_KEY");
  const sttKey = env("STT_API_KEY") ?? env("OPENAI_API_KEY");
  return {
    port: Number(env("PORT") ?? 3000),
    host: env("HOST") ?? "0.0.0.0",
    dbFile: env("DB_FILE") ?? path.join(dataDir, "planner.db"),
    defaultZone: safeZone(env("DEFAULT_TIMEZONE")),
    llm: llmConfig(),
    embeddings: embKey
      ? { baseUrl: env("EMBEDDINGS_BASE_URL") ?? "https://api.openai.com/v1", apiKey: embKey, model: env("EMBEDDINGS_MODEL") ?? "text-embedding-3-small" }
      : null,
    stt: sttKey ? { baseUrl: env("STT_BASE_URL") ?? "https://api.openai.com/v1", apiKey: sttKey, model: env("STT_MODEL") ?? "whisper-1" } : null,
  };
}
