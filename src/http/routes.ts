import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppServices } from "../app.js";
import { occurrenceView } from "../domain/format.js";
import { toICalendar } from "../domain/ical.js";
import { safeZone, weekRange } from "../domain/time.js";
import type { Occurrence } from "../domain/types.js";

const USER_ID = /^[A-Za-z0-9_-]{8,64}$/;

interface Caller {
  userId: string;
  zone: string;
}

/** Anonymous multi-user: the browser keeps a random id in localStorage and sends it with every call. */
function caller(req: FastifyRequest, reply: FastifyReply): Caller | null {
  const userId = String(req.headers["x-user-id"] ?? "");
  if (!USER_ID.test(userId)) {
    void reply.code(400).send({ error: "Missing or invalid X-User-Id header" });
    return null;
  }
  return { userId, zone: safeZone(String(req.headers["x-timezone"] ?? "")) };
}

const ChatBody = z.object({ text: z.string().trim().min(1).max(500) });
const CompleteBody = z.object({ done: z.boolean().default(true) });
const AgendaQuery = z.object({ view: z.enum(["today", "week", "upcoming", "all", "done"]).default("upcoming") });

export function registerRoutes(app: FastifyInstance, s: AppServices): void {
  app.get("/api/health", async () => ({
    ok: true,
    engine: s.assistant.engineName,
    llm: s.config.llm.kind !== "none",
    semanticSearch: s.semanticSearch,
    serverStt: Boolean(s.stt),
  }));

  app.post("/api/chat", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    const body = ChatBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "text is required (1–500 chars)" });
    return s.assistant.handle(c.userId, c.zone, body.data.text);
  });

  app.get("/api/history", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    return { history: s.sessions.load(c.userId).history };
  });

  app.post("/api/session/reset", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    s.sessions.reset(c.userId);
    return { ok: true };
  });

  app.get("/api/agenda", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    const { view } = AgendaQuery.parse(req.query);
    const now = s.planner.now(c.zone);
    const today = now.startOf("day");
    let occ: Occurrence[];
    if (view === "today") occ = s.planner.list(c.userId, c.zone, { from: today, to: today.plus({ days: 1 }) }, { includeDone: true });
    else if (view === "week") occ = s.planner.list(c.userId, c.zone, weekRange(today), { includeDone: true });
    else if (view === "upcoming")
      occ = s.planner.list(c.userId, c.zone, { from: today, to: today.plus({ days: 30 }) }, { includeUndated: true });
    else {
      const items = s.planner
        .allItems(c.userId)
        .filter((i) => (view === "done" ? i.status === "done" : true));
      occ = items.map((i) => s.planner.relevantOccurrence(i, c.zone));
    }
    return { view, items: occ.map((o) => occurrenceView(o, now)) };
  });

  app.post<{ Params: { id: string } }>("/api/items/:id/complete", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    const { done } = CompleteBody.parse(req.body ?? {});
    const res = s.planner.complete(c.userId, c.zone, req.params.id, done);
    if (!res) return reply.code(404).send({ error: "not found" });
    const now = s.planner.now(c.zone);
    return { item: occurrenceView(res.advancedTo ?? s.planner.firstOccurrence(res.item, c.zone), now) };
  });

  app.delete<{ Params: { id: string } }>("/api/items/:id", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    const item = s.planner.delete(c.userId, req.params.id);
    if (!item) return reply.code(404).send({ error: "not found" });
    const session = s.sessions.load(c.userId);
    session.lastDeleted = item;
    s.sessions.save(c.userId, session);
    return { ok: true };
  });

  app.get("/api/reminders/due", async (req, reply) => {
    const c = caller(req, reply);
    if (!c) return;
    const now = s.planner.now(c.zone);
    return { due: s.planner.dueNotifications(c.userId, c.zone).map((o) => occurrenceView(o, now)) };
  });

  // Raw audio upload for browsers without Web Speech API.
  app.addContentTypeParser(/^audio\/.*/, { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post("/api/stt", async (req, reply) => {
    if (!s.stt) return reply.code(501).send({ error: "Server speech recognition is not configured" });
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length < 1000) return reply.code(400).send({ error: "Empty recording" });
    try {
      return { text: await s.stt.transcribe(audio, String(req.headers["content-type"] ?? "audio/webm")) };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Speech recognition failed" });
    }
  });

  // iCalendar subscription feed. The URL contains the user's random id, like a private calendar link.
  app.get<{ Params: { file: string } }>("/calendar/:file", async (req, reply) => {
    const userId = req.params.file.replace(/\.ics$/, "");
    if (!USER_ID.test(userId)) return reply.code(404).send("not found");
    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("content-disposition", 'inline; filename="planner.ics"')
      .send(toICalendar(s.planner.allItems(userId)));
  });
}
