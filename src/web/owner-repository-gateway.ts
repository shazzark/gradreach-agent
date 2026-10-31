import type { ConnectedMongoStorage, GradReachRepositories } from '../infrastructure/mongo-storage.ts';
import { isOwnerSession, type OwnerSession } from './owner-access.ts';

export class OwnerAccessDenied extends Error {
  constructor() {
    super('Owner authentication is required');
    this.name = 'OwnerAccessDenied';
  }
}

/** Authorizes before connecting, then closes the request-scoped Mongo client. */
export async function withOwnerRepositories<Result>(input: {
  getSession(): Promise<OwnerSession | null>;
  ownerEmail: string | undefined;
  connect(): Promise<ConnectedMongoStorage>;
}, operation: (repositories: GradReachRepositories) => Promise<Result>): Promise<Result> {
  const session = await input.getSession();
  if (!isOwnerSession(session, input.ownerEmail)) throw new OwnerAccessDenied();

  const storage = await input.connect();
  try {
    return await operation(storage.repositories);
  } finally {
    await storage.close();
  }
}
