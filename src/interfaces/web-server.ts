import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import next from 'next';
import { Server } from 'socket.io';
import type { JobProgressEvent } from '../domain/job-progress.ts';
import { attachJobProgressSocket } from '../infrastructure/socket-progress-server.ts';

interface ClientEvents {}
interface ServerEvents { 'job:progress': (event: JobProgressEvent) => void }

export async function runWebServer(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const hostname = process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');

  const dev = process.argv.includes('--dev');
  const app = next({ dev, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const httpServer = createServer((request, response) => { void handle(request, response); });
  const io = new Server<ClientEvents, ServerEvents>(httpServer, {
    path: '/api/socket.io',
    maxHttpBufferSize: 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });
  const secret = process.env.AUTH_SECRET;
  const ownerEmail = process.env.GRADREACH_OWNER_EMAIL;
  const unsubscribe = attachJobProgressSocket({
    io, ownerEmail, secret, authUrl: process.env.AUTH_URL, isProduction: process.env.NODE_ENV === 'production',
  });
  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, hostname, () => {
      httpServer.removeListener('error', reject);
      resolvePromise();
    });
  });
  process.stdout.write(`GradReach web server listening on ${hostname}:${port}.\n`);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    unsubscribe();
    io.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runWebServer().catch(() => {
    process.stderr.write('Could not start the GradReach web server; check local configuration and runtime availability.\n');
    process.exitCode = 1;
  });
}
