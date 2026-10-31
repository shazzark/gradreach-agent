import 'server-only';
import { redirect } from 'next/navigation';
import { buildDashboardSnapshot } from '../application/dashboard.ts';
import type { DashboardSnapshot } from '../application/dashboard.ts';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { CandidateEvidenceTriage, OutreachAttempt, ProfessorCandidate, SchedulerControl } from '../domain/outreach-queue.ts';
import type { ProgramAssessment, ProgramRecord } from '../domain/program-assessment.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { auth } from '../../auth.ts';
import type { GradReachRepositories } from '../infrastructure/mongo-storage.ts';
import { withOwnerRepositories } from './owner-repository-gateway.ts';
import { isOwnerSession } from './owner-access.ts';

export { withOwnerRepositories } from './owner-repository-gateway.ts';

export async function requireOwner(): Promise<void> {
  if (!isOwnerSession(await auth(), process.env.GRADREACH_OWNER_EMAIL)) redirect('/sign-in');
}

export interface OwnerWorkspace {
  profile: ApplicantProfile;
  candidates: ProfessorCandidate[];
  triage: CandidateEvidenceTriage[];
  programs: ProgramRecord[];
  assessments: ProgramAssessment[];
  attempts: OutreachAttempt[];
  control: SchedulerControl;
  dashboard: DashboardSnapshot;
}

export async function withOwnerData<Result>(operation: (repositories: GradReachRepositories) => Promise<Result>): Promise<Result> {
  return withOwnerRepositories({
    getSession: auth,
    ownerEmail: process.env.GRADREACH_OWNER_EMAIL,
    connect: connectMongoStorage,
  }, operation);
}

export async function getOwnerWorkspace(): Promise<OwnerWorkspace> {
  return withOwnerData(async (repositories) => {
    const profile = await repositories.profiles.get('primary');
    if (!profile) throw new Error('The private applicant profile is not configured in GradReach storage');
    const [candidates, triage, programs, attempts, savedControl] = await Promise.all([
      repositories.candidates.list(),
      repositories.evidenceTriage.list(),
      repositories.programs.list(),
      repositories.attempts.listAll(),
      repositories.schedulerControl.get(),
    ]);
    const control = savedControl ?? { paused: true, timeZone: profile.applicant.target.timezone, dailyLimit: 5 };
    const assessments = (await Promise.all(programs.map((program) => repositories.assessments.latest(program.id))))
      .filter((item): item is ProgramAssessment => item !== undefined);
    const dashboard = buildDashboardSnapshot({
      candidates, programs, assessments, attempts, control, now: new Date().toISOString(),
    });
    return { profile, candidates, triage, programs, assessments, attempts, control, dashboard };
  });
}
