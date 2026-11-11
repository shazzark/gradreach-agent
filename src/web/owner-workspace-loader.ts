import { buildDashboardSnapshot } from '../application/dashboard.ts';
import type { DashboardSnapshot } from '../application/dashboard.ts';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import { createEmptyApplicantProfile, isApplicantProfileIncomplete } from '../domain/applicant-profile.ts';
import type { CandidateEvidenceTriage, OutreachAttempt, ProfessorCandidate, SchedulerControl } from '../domain/outreach-queue.ts';
import type { ProgramAssessment, ProgramRecord } from '../domain/program-assessment.ts';
import type { DiscoveryEvidenceCheck } from '../application/automatic-discovery.ts';
import type { GradReachRepositories } from '../infrastructure/mongo-storage.ts';

export interface OwnerWorkspace {
  profile: ApplicantProfile;
  profileSetupRequired: boolean;
  candidates: ProfessorCandidate[];
  triage: CandidateEvidenceTriage[];
  discoveryChecks: DiscoveryEvidenceCheck[];
  programs: ProgramRecord[];
  assessments: ProgramAssessment[];
  attempts: OutreachAttempt[];
  control: SchedulerControl;
  dashboard: DashboardSnapshot;
}

/** Builds the view data from repositories; callers must enforce owner access before calling. */
export async function loadOwnerWorkspace(repositories: GradReachRepositories, now = new Date().toISOString()): Promise<OwnerWorkspace> {
  const savedProfile = await repositories.profiles.get('primary');
  const profile = savedProfile ?? createEmptyApplicantProfile();
  const [candidates, triage, discoveryChecks, programs, attempts, savedControl] = await Promise.all([
    repositories.candidates.list(),
    repositories.evidenceTriage.list(),
    repositories.discoveryChecks.list(100),
    repositories.programs.list(),
    repositories.attempts.listAll(),
    repositories.schedulerControl.get(),
  ]);
  const control = savedControl ?? { paused: true, timeZone: profile.applicant.target.timezone, dailyLimit: 5 };
  const assessments = (await Promise.all(programs.map((program) => repositories.assessments.latest(program.id))))
    .filter((item): item is ProgramAssessment => item !== undefined);
  const dashboard = buildDashboardSnapshot({ candidates, programs, assessments, attempts, control, now });
  return { profile, profileSetupRequired: isApplicantProfileIncomplete(savedProfile), candidates, triage, discoveryChecks, programs, assessments, attempts, control, dashboard };
}
