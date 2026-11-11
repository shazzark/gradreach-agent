import 'server-only';
import { redirect } from 'next/navigation';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import type { GradReachRepositories } from '../infrastructure/mongo-storage.ts';
import { auth } from '../../auth.ts';
import { withOwnerRepositories } from './owner-repository-gateway.ts';
import { isOwnerSession } from './owner-access.ts';
import { loadOwnerWorkspace } from './owner-workspace-loader.ts';
import type { OwnerWorkspace } from './owner-workspace-loader.ts';

export { withOwnerRepositories } from './owner-repository-gateway.ts';
export { loadOwnerWorkspace } from './owner-workspace-loader.ts';
export type { OwnerWorkspace } from './owner-workspace-loader.ts';

export async function requireOwner(): Promise<void> {
  if (!isOwnerSession(await auth(), process.env.GRADREACH_OWNER_EMAIL)) redirect('/sign-in');
}

export async function withOwnerData<Result>(operation: (repositories: GradReachRepositories) => Promise<Result>): Promise<Result> {
  return withOwnerRepositories({
    getSession: auth,
    ownerEmail: process.env.GRADREACH_OWNER_EMAIL,
    connect: connectMongoStorage,
  }, operation);
}

export async function getOwnerWorkspace(): Promise<OwnerWorkspace> {
  return withOwnerData((repositories) => loadOwnerWorkspace(repositories));
}
