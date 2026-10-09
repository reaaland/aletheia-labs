#!/usr/bin/env bun
/**
 * Static server for the demo pages this repository authors itself, so that the
 * browser layer can be exercised end to end without touching any other team's
 * fixture.
 *
 * It binds its OWN variable -- never `PORT`, which this environment exports as
 * 80, and never 3000, which the team site owns.
 *
 *   bun run fixtures/web/serve.ts        # http://127.0.0.1:4287
 *   ALETHEIA_DEMO_PORT=5000 bun run fixtures/web/serve.ts
 */
import { join } from "node:path";

const port = Number(Bun.env.ALETHEIA_DEMO_PORT ?? 4287);
const root = import.meta.dir;

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path === "/health") return new Response("ok\n");
    const file = Bun.file(join(root, path));
    if (await file.exists()) {
      const headers: Record<string, string> = { "cache-control": "no-store" };
      if (path.endsWith(".html")) headers["content-type"] = "text/html; charset=utf-8";
      return new Response(file, { headers });
    }
    return new Response("not found\n", { status: 404 });
  },
});

process.stdout.write(`corner-shop demo running at http://127.0.0.1:${server.port}/\n`);
