import Fastify from "fastify";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { buildServices } from "../src/app.js";
import { registerRoutes } from "../src/http/routes.js";
import { NOW_ISO, testConfig, ZONE } from "./helpers.js";

function server() {
  const services = buildServices(testConfig(), { clock: () => DateTime.fromISO(NOW_ISO, { zone: ZONE }), provider: null });
  const app = Fastify();
  registerRoutes(app, services);
  return app;
}

const headers = { "x-user-id": "http-test-user", "x-timezone": ZONE };

describe("HTTP API", () => {
  it("rejects calls without a user id", async () => {
    const res = await server().inject({ method: "POST", url: "/api/chat", payload: { text: "привет" } });
    expect(res.statusCode).toBe(400);
  });

  it("chat → agenda → complete → calendar feed", async () => {
    const app = server();
    const chat = await app.inject({ method: "POST", url: "/api/chat", headers, payload: { text: "Добавь встречу с командой завтра в 15:00" } });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({ engine: "rules", awaiting: false, actions: [{ kind: "created" }] });

    const agenda = await app.inject({ method: "GET", url: "/api/agenda?view=upcoming", headers });
    const items = agenda.json().items;
    expect(items).toHaveLength(1);

    const done = await app.inject({ method: "POST", url: `/api/items/${items[0].id}/complete`, headers, payload: { done: true } });
    expect(done.json().item.status).toBe("done");

    const ics = await app.inject({ method: "GET", url: "/calendar/http-test-user.ics" });
    expect(ics.headers["content-type"]).toContain("text/calendar");
    expect(ics.body).toContain("SUMMARY:Встреча с командой");

    const history = await app.inject({ method: "GET", url: "/api/history", headers });
    expect(history.json().history).toHaveLength(2);
  });

  it("validates chat payload", async () => {
    const res = await server().inject({ method: "POST", url: "/api/chat", headers, payload: { text: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("reports health and capabilities", async () => {
    const res = await server().inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toEqual({ ok: true, engine: "rules", llm: false, semanticSearch: false, serverStt: false });
  });

  it("server STT returns 501 when not configured", async () => {
    const res = await server().inject({ method: "POST", url: "/api/stt", headers: { ...headers, "content-type": "audio/webm" }, payload: Buffer.alloc(2000) });
    expect(res.statusCode).toBe(501);
  });
});
