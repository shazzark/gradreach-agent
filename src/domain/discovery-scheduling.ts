import type { ProfessorResearchEvidencePackage } from './professor-research-evidence.ts';

export type DiscoveryFrequency = 'daily' | 'weekly';

export interface DiscoverySchedule {
  enabled: boolean;
  paused: boolean;
  frequency: DiscoveryFrequency;
  dayOfWeek: number;
  time: string;
  timeZone: string;
  countries: string[];
}

export interface DiscoveryEvidenceCheck {
  id: string;
  candidateId: string;
  sourceUrl: string;
  checkedAt: string;
  runId: string;
  outcome: 'checked' | 'failed';
  excerpt?: string;
  evidencePackage?: ProfessorResearchEvidencePackage;
  failureCode?: string;
}

export interface DiscoveryRun {
  id: string;
  scheduledFor: string;
  startedAt: string;
  completedAt?: string;
  country?: string;
  targetingMode?: 'api_country' | 'query_and_host';
  state: 'running' | 'completed' | 'failed' | 'paused' | 'not_due';
  counts: { searches: number; results: number; saved: number; duplicates: number; rejections: number; fetchFailures: number; inspected: number; inspectionFailures: number };
  failureCode?: string;
}
