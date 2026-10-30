import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CandidateEvidenceTriage, ProfessorCandidate } from '../domain/outreach-queue.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';

interface ReadOnlyRepositories {
  candidates: { list(): Promise<ProfessorCandidate[]> };
  evidenceTriage: { get(candidateId: string): Promise<CandidateEvidenceTriage | undefined> };
}

interface ReadOnlyStorage {
  repositories: ReadOnlyRepositories;
  close(): Promise<void>;
}

type FailureStage = 'mongodb_connection' | 'candidate_read' | 'recommendation_read';

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderLead(candidate: ProfessorCandidate, triage?: CandidateEvidenceTriage): string {
  const evidence = candidate.discoveryEvidence ?? [];
  const profile = evidence.find((item) => item.kind === 'professor-profile' && item.sourceUrl === candidate.officialProfileUrl);
  const contact = evidence.find((item) => item.kind === 'contact' && item.sourceUrl === candidate.emailSourceUrl);
  const lines = [
    `${terminalText(candidate.name)} | ${terminalText(candidate.id)}`,
    `Institution: ${terminalText(candidate.institution || 'Unknown')} | Country: ${terminalText(candidate.country || 'Unknown')}`,
    `Official profile [${profile?.verification ?? 'unavailable'}]: ${terminalText(profile?.sourceUrl ?? candidate.officialProfileUrl ?? 'Unavailable')}`,
    `Supporting quote: "${terminalText(profile?.quote ?? profile?.excerpt ?? 'Unavailable')}"`,
  ];

  if (candidate.officialEmail) {
    lines.push(`Official email [${contact?.verification ?? 'no matching contact evidence'}]: ${terminalText(candidate.officialEmail)}`);
    if (contact) lines.push(`Email evidence: ${terminalText(contact.sourceUrl)}`);
  } else {
    lines.push('Official email: None found.');
  }
  if (triage) lines.push(`Saved recommendation (${triage.recommendation}): ${terminalText(triage.rationale)}`);
  return lines.join('\n');
}

/** Reads only candidates and their saved triage; it has no startup-write or provider dependencies. */
export async function runReadOnlyLeadViewer(input: {
  connect: () => Promise<ReadOnlyStorage>;
  write?: (text: string) => void;
}): Promise<boolean> {
  const write = input.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  let storage: ReadOnlyStorage | undefined;
  let stage: FailureStage = 'mongodb_connection';
  try {
    storage = await input.connect();
    stage = 'candidate_read';
    const candidates = (await storage.repositories.candidates.list()).filter((candidate) =>
      candidate.leadType === 'professor_profile' && candidate.status === 'needs-evidence' &&
      !candidate.discoveryReview && !candidate.approvedForSending,
    );
    if (candidates.length === 0) {
      write('No undecided professor leads need review.');
      return true;
    }

    for (const candidate of candidates) {
      stage = 'recommendation_read';
      const triage = await storage.repositories.evidenceTriage.get(candidate.id);
      write(renderLead(candidate, triage));
    }
    return true;
  } catch (error) {
    const failure = safeFailureRecord(error);
    write(`Read failed at ${stage}: ${failure.kind}: ${failure.message}${failure.causeCode ? ` (${failure.causeCode})` : ''}`);
    return false;
  } finally {
    try { await storage?.close(); } catch { /* Closing the read-only client must not expose raw driver errors. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const succeeded = await runReadOnlyLeadViewer({ connect: () => connectMongoStorage() });
  if (!succeeded) process.exitCode = 1;
}
