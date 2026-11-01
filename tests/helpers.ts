import { DateTime } from "luxon";
import { buildServices } from "../src/app.js";
import type { AppConfig } from "../src/config/config.js";
import type { LlmProvider } from "../src/llm/provider.js";

export const ZONE = "Europe/Moscow";
/** Wednesday, 4 November 2026, 12:00 Moscow. */
export const NOW_ISO = "2026-11-04T12:00:00";

export function testConfig(): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dbFile: ":memory:",
    defaultZone: ZONE,
    llm: { kind: "none" },
    embeddings: null,
    stt: null,
  };
}

/** Full stack on an in-memory database with a controllable clock. */
export function makeApp(opts: { provider?: LlmProvider | null; now?: string } = {}) {
  let now = DateTime.fromISO(opts.now ?? NOW_ISO, { zone: ZONE });
  const services = buildServices(testConfig(), { clock: () => now, provider: opts.provider ?? null });
  const user = "test-user-1";
  return {
    ...services,
    user,
    say: (text: string) => services.assistant.handle(user, ZONE, text),
    setNow: (iso: string) => {
      now = DateTime.fromISO(iso, { zone: ZONE });
    },
    now: () => now,
  };
}
