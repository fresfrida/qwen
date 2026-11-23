// Bootstrap only: build the container, bind a socket, shut down cleanly.
// No route logic and no business rule lives here.

import { createServer } from 'node:http';
import { buildContainer } from './container.js';
import { createHandler } from './routes.js';

export async function start({ env = process.env, port, quiet = false } = {}) {
  const container = buildContainer(env);
  if (quiet) container.log = () => {};

  // Claims left running by a previous process are resolved before a single request is served.
  // Without this, a stage killed mid-run reads as "in progress" forever and a refresh shows work
  // nobody is doing. Recovery marks it failed; it never retries it.
  if (container.films?.recoverInterrupted) {
    const recovered = await container.films.recoverInterrupted();
    if (recovered.length) container.log('recovered_interrupted', { stages: recovered.map((r) => `${r.id.slice(0, 8)}/${r.stage}`).join(',') });
  }
  const handler = createHandler(container);

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      container.log('unhandled', { msg: String(err?.message ?? err).slice(0, 200) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff' });
      res.end('error');
    });
  });

  server.keepAliveTimeout = 5000;
  server.requestTimeout = 30000;          // slow-loris bound: 30s for headers+body
  server.headersTimeout = 10000;

  const listenPort = port ?? container.config.port;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '0.0.0.0', resolve); });

  let closing = false;
  const stopStore = container.studio?.stopInFlight
    ? () => container.studio.stopInFlight()
    : () => container.films?.stopInFlight?.() ?? Promise.resolve();

  const close = async () => {
    if (closing) return;
    closing = true;
    // Order matters: stop taking requests, give in-flight stage work a moment to record itself,
    // then drop the keep-alive sockets that would otherwise make server.close() wait forever.
    const noLaterThan = new Promise((r) => setTimeout(r, 2_000));
    await Promise.race([stopStore(), noLaterThan]);
    server.closeIdleConnections?.();
    const drained = new Promise((r) => server.close(r));
    await Promise.race([drained, new Promise((r) => setTimeout(r, 1_000))]);
    server.closeAllConnections?.();          // an operator's Ctrl-C must not hang on a browser socket
    await drained;                            // now resolve for real, after connections are gone
  };

  container.log('listening', { port: server.address().port, mode: container.config.mode, storage: container.config.mode === 'live' ? 'file' : 'disabled' });
  return { server, container, config: container.config, port: server.address().port, close };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const app = await start();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      app.container.log('shutdown', { signal: sig });
      // a submission arriving during shutdown is refused, never half-written
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10000))]);
      process.exit(0);
    });
  }
}
