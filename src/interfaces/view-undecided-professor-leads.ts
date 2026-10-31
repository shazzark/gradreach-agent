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

function displaySourceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return 'Unavailable';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return 'Unavailable'; }
}

function isIndividualProfessorProfile(candidate: ProfessorCandidate): boolean {
  if (candidate.leadType !== 'professor_profile' || !candidate.professorName?.trim() || !candidate.officialProfileUrl) return false;
  const evidence = (candidate.discoveryEvidence ?? []).find((item) =>
    item.kind === 'professor-profile' && item.sourceUrl === candidate.officialProfileUrl && Boolean(item.quote?.trim()),
  );
  const namePattern = new RegExp(candidate.professorName.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
  return Boolean(evidence && namePattern.test(evidence.excerpt) && Boolean(evidence.quote?.trim()));
}

function renderLead(candidate: ProfessorCandidate, triage?: CandidateEvidenceTriage): string {
  const evidence = candidate.discoveryEvidence ?? [];
  const profile = evidence.find((item) => item.kind === 'professor-profile' && item.sourceUrl === candidate.officialProfileUrl);
  const contact = evidence.find((item) => item.kind === 'contact' && item.sourceUrl === candidate.emailSourceUrl);
  const lines = [
    `Lead/page title: ${terminalText(candidate.name)} | Professor: ${terminalText(candidate.professorName ?? 'Not established')} | ${terminalText(candidate.id)}`,
    `Institution: ${terminalText(candidate.institution || 'Unknown')} | Country: ${terminalText(candidate.country || 'Unknown')}`,
    `Official profile [${profile?.verification ?? 'unavailable'}]: ${terminalText(displaySourceUrl(profile?.sourceUrl ?? candidate.officialProfileUrl ?? ''))}`,
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

function renderGeneralLead(candidate: ProfessorCandidate): string {
  const sources = [...new Map((candidate.discoveryEvidence ?? []).map((item) => [
    `${item.kind}:${displaySourceUrl(item.sourceUrl)}`,
    `  ${item.kind}: ${displaySourceUrl(item.sourceUrl)}`,
  ])).values()];
  return [
    `Lead/page title: ${terminalText(candidate.name)} | ${terminalText(candidate.id)}`,
    `Lead type: ${candidate.leadType ?? 'unclassified'} | Professor: Not established from saved profile evidence.`,
    ...(sources.length ? ['Sources:', ...sources] : ['Sources: Unavailable']),
  ].join('\n');
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
    const pending = (await storage.repositories.candidates.list()).filter((candidate) =>
      candidate.status === 'needs-evidence' && !candidate.discoveryReview && !candidate.approvedForSending,
    );
    const professors = pending.filter(isIndividualProfessorProfile);
    const general = pending.filter((candidate) => !isIndividualProfessorProfile(candidate));
    if (pending.length === 0) {
      write('No undecided leads need review.');
      return true;
    }

    write(`Individual professor profiles needing review: ${professors.length}`);
    for (const candidate of professors) {
      stage = 'recommendation_read';
      const triage = await storage.repositories.evidenceTriage.get(candidate.id);
      write(renderLead(candidate, triage));
    }
    write(`General or unclassified leads needing review: ${general.length}`);
    for (const candidate of general) write(renderGeneralLead(candidate));
    return true;
  } catch (error) {
    const failure = safeFailureRecord(error);
    const diagnostics = [
      failure.errorName ? `error=${failure.errorName}` : undefined,
      failure.codeName ? `codeName=${failure.codeName}` : undefined,
      failure.errorCode ? `code=${failure.errorCode}` : undefined,
      failure.atlasCategory ? `category=${failure.atlasCategory}` : undefined,
      failure.causeName ? `cause=${failure.causeName}` : undefined,
      failure.causeCode ? `causeCode=${failure.causeCode}` : undefined,
      failure.syscall ? `syscall=${failure.syscall}` : undefined,
      failure.serverStates ? `servers=${failure.serverStates.join(',')}` : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    write(`Read failed at ${stage}: ${failure.kind}: ${failure.message}${diagnostics.length ? ` [${diagnostics.join(' ')}]` : ''}`);
    return false;
  } finally {
    try { await storage?.close(); } catch { /* Closing the read-only client must not expose raw driver errors. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const succeeded = await runReadOnlyLeadViewer({ connect: () => connectMongoStorage() });
  if (!succeeded) process.exitCode = 1;
}
