import type { Server } from 'socket.io';
import type { JobProgressEvent } from '../domain/job-progress.ts';
import { subscribeToJobProgress } from './job-progress-bus.ts';
import { isAuthorizedSocketHandshake } from '../web/socket-progress-auth.ts';

interface ClientEvents {}
interface ServerEvents { 'job:progress': (event: JobProgressEvent) => void }

/** Adds owner-only authorization and transient progress fan-out to an attached Socket.IO server. */
export function attachJobProgressSocket(input: {
  io: Server<ClientEvents, ServerEvents>;
  ownerEmail: string | undefined;
  secret: string | undefined;
  authUrl: string | undefined;
  isProduction: boolean;
}): () => void {
  input.io.use(async (socket, next) => {
    const authorized = await isAuthorizedSocketHandshake({
      headers: socket.request.headers,
      ownerEmail: input.ownerEmail,
      secret: input.secret,
      authUrl: input.authUrl,
      isProduction: input.isProduction,
    });
    next(authorized ? undefined : new Error('unauthorized'));
  });
  return subscribeToJobProgress((event) => { input.io.emit('job:progress', event); });
}
