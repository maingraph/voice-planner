import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServices } from "./app.js";
import { loadConfig } from "./config/config.js";
import { registerRoutes } from "./http/routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const services = buildServices(config);
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 64 * 1024 });

  registerRoutes(app, services);
  await app.register(fastifyStatic, { root: path.resolve(here, "..", "public") });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`engine: ${services.assistant.engineName}; semantic search: ${services.semanticSearch}; server STT: ${Boolean(services.stt)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
