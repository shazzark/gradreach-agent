import '../infrastructure/local-env.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractOfficialPageExcerpt, extractProfessorIdentityEvidence, extractResearchQuote, enrichOfficialCandidate, fetchOfficialPage, MAX_OFFICIAL_PAGE_FETCHES_PER_RUN, officialResearchLinkDiagnostics } from '../application/research-discovery.ts';
import { matchingResearchInterests } from '../application/professor-research-evidence.ts';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { ProfessorCandidate } from '../domain/outreach-queue.ts';
import { OFFICIAL_HOSTS_BY_REGION, OFFICIAL_INSTITUTION_BY_REGION } from '../config/official-host-allowlist.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { safeFailureRecord, type SafeFailureKind } from '../infrastructure/sanitized-failure.ts';

const CANDIDATES = [
  { recordId: 'candidate-01', sourceUrl: 'https://uwaterloo.ca/electrical-computer-engineering/profile/a2boutro' },
  { recordId: 'candidate-02', sourceUrl: 'https://uwaterloo.ca/computer-science/advising' },
  { recordId: 'candidate-03', sourceUrl: 'https://uwaterloo.ca/electrical-computer-engineering/profile/ecreager' },
] as const;
const REGION = 'Canada';
const HOSTS: string[] = [...OFFICIAL_HOSTS_BY_REGION[REGION]];
const MAX_SAVED_EXCERPTS = 3;

export interface ReplayFetchRecord {
  sourceUrl: string;
  fetchStatus: 'fetched' | 'failed';
  httpStatus?: number;
  contentType?: string;
  errorCode?: SafeFailureKind;
}

export interface SavedPreviewCandidateDiagnostic {
  recordId: string;
  profile: ReplayFetchRecord;
  identity: {
    established: boolean;
    sourceUrl: string;
    supportingExcerpt: string;
  };
  research: {
    linksConsidered: string[];
    linksSelected: Array<{ sourceUrl: string; rank: number; reasons: string[] }>;
    linksFetched: ReplayFetchRecord[];
    textExtracted: boolean;
    extractedSourceUrl?: string;
    supportingExcerpt?: string;
    observedResearchExcerpts: Array<{ sourceUrl: string; excerpt: string }>;
    observedTextMatchedSavedInterests: boolean | null;
    matchedSavedInterests: boolean | null;
  };
  stopReason: 'profile_fetch_failed' | 'identity_not_established' | 'no_research_links' | 'research_fetch_failed' | 'unsupported_content' | 'no_research_text_extracted' | 'research_interest_not_matched' | 'passed_all_gates';
}

export interface SavedPreviewDiagnosticReport {
  generatedAt: string;
  institution: string;
  inspected: number;
  totalPageFetches: number;
  candidates: SavedPreviewCandidateDiagnostic[];
}

interface ReplayInput {
  profile: ApplicantProfile;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface CapturedPage {
  url: string;
  html: string;
}

function reportText(value: string, maximum = 360): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]')
    .replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function safeSource(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !HOSTS.includes(url.hostname.toLowerCase()) || url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

function mediaType(value: string | null): string | undefined {
  const type = value?.split(';', 1)[0]?.trim().toLowerCase();
  return type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : undefined;
}

function savedResearchSnippets(html: string): string[] {
  const blocks = [...html.matchAll(/<(p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
    .map((match) => reportText(extractOfficialPageExcerpt(match[2] ?? ''), 300))
    .filter((text) => text.length >= 60 && /\b(research|focus(?:es)?|investigat(?:e|es)|develop(?:s)?|stud(?:y|ies)|work on|laborator(?:y|ies)|project)\b/i.test(text));
  return [...new Set(blocks)].slice(0, MAX_SAVED_EXCERPTS);
}

function pageTitleExcerpt(html: string): string {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1] ?? '';
  return reportText(extractOfficialPageExcerpt(heading), 180);
}

function attemptedRecord(sourceUrl: string, observations: ReplayFetchRecord[], fallbackError?: unknown): ReplayFetchRecord {
  const safeUrl = safeSource(sourceUrl) ?? sourceUrl;
  const existing = observations.findLast((record) => record.sourceUrl === safeUrl);
  if (existing) return existing;
  const failure = fallbackError === undefined ? undefined : safeFailureRecord(fallbackError, safeUrl);
  return {
    sourceUrl: safeUrl,
    fetchStatus: 'failed',
    ...(failure?.statusCode ? { httpStatus: failure.statusCode } : {}),
    ...(failure ? { errorCode: failure.kind } : {}),
  };
}

async function captureOfficialPage(
  url: string,
  fetchImpl: typeof fetch,
  attempts: ReplayFetchRecord[],
  pages: CapturedPage[],
): Promise<{ url: string; html: string }> {
  let responseStatus: number | undefined;
  let responseType: string | undefined;
  const safeUrl = safeSource(url) ?? url;
  const pending: ReplayFetchRecord = { sourceUrl: safeUrl, fetchStatus: 'failed' };
  attempts.push(pending);
  const observingFetch: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    responseStatus = response.status;
    responseType = mediaType(response.headers.get('content-type'));
    return response;
  };
  try {
    if (!safeSource(url)) throw new Error('disallowed_host');
    const page = await fetchOfficialPage(safeUrl, HOSTS, observingFetch);
    const finalUrl = safeSource(page.url) ?? safeUrl;
    Object.assign(pending, { fetchStatus: 'fetched', ...(responseStatus ? { httpStatus: responseStatus } : {}), ...(responseType ? { contentType: responseType } : {}) });
    pages.push({ url: finalUrl, html: page.html });
    return { ...page, url: finalUrl };
  } catch (error) {
    const failure = safeFailureRecord(error, safeUrl);
    Object.assign(pending, {
      ...(responseStatus ?? failure.statusCode ? { httpStatus: responseStatus ?? failure.statusCode } : {}),
      ...(responseType ? { contentType: responseType } : {}), errorCode: failure.kind });
    throw error;
  }
}

function initialCandidate(recordId: string, sourceUrl: string, checkedAt: string): ProfessorCandidate {
  return {
    id: `preview-${recordId}`,
    name: recordId,
    institution: OFFICIAL_INSTITUTION_BY_REGION[REGION],
    country: REGION,
    leadType: 'discovery',
    searchRegion: REGION,
    sourceCheckedAt: checkedAt,
    discoveryEvidence: [{ kind: 'search-result', sourceUrl, excerpt: 'Saved preview profile source.', retrievedAt: checkedAt, verification: 'unverified', region: REGION, query: '' }],
    status: 'needs-evidence', approvedForSending: false, priority: 0,
  };
}

export async function replaySavedPreviewCandidates(input: ReplayInput): Promise<SavedPreviewDiagnosticReport> {
  if (!input.profile.applicant.target.countries.includes(REGION)) throw new Error('preview_country_not_configured');
  const generatedAt = (input.now?.() ?? new Date()).toISOString();
  const interests = [...input.profile.applicant.target.researchInterests, ...input.profile.applicant.target.fields];
  const pageBudget = { remaining: MAX_OFFICIAL_PAGE_FETCHES_PER_RUN };
  const attempts: ReplayFetchRecord[] = [];
  const pages: CapturedPage[] = [];
  const candidates: SavedPreviewCandidateDiagnostic[] = [];
  for (const saved of CANDIDATES) {
    const profileUrl = safeSource(saved.sourceUrl);
    if (!profileUrl) throw new Error('disallowed_host');
    const candidate = initialCandidate(saved.recordId, profileUrl, generatedAt);
    let identityUrl: string | undefined;
    let failure: unknown;
    try {
      await enrichOfficialCandidate(candidate, [...HOSTS], {
        pageFetchBudget: pageBudget,
        maxResearchPagesPerProfile: 5,
        followSupplementaryLinks: false,
        collectContactEmail: false,
        fetchPage: (url) => captureOfficialPage(url, input.fetchImpl ?? fetch, attempts, pages),
        onProfessorIdentity: (identity) => { identityUrl = safeSource(identity.officialProfileUrl); },
      });
    } catch (error) {
      failure = error;
    }
    const profileFetch = attemptedRecord(profileUrl, attempts, failure);
    const profilePage = pages.find((page) => page.url === profileUrl) ?? pages.find((page) => page.url === profileFetch.sourceUrl);
    const identitySource = identityUrl ?? profileUrl;
    const identityPage = pages.find((page) => page.url === identitySource);
    const identityEvidence = identityPage ? extractProfessorIdentityEvidence(identityPage.html) : undefined;
    const identityExcerpt = identityEvidence?.identityQuote ?? (profilePage ? pageTitleExcerpt(profilePage.html) : '');
    let linksConsidered: string[] = [];
    let linksSelected: Array<{ sourceUrl: string; rank: number; reasons: string[] }> = [];
    if (identityEvidence && identityPage && !extractResearchQuote(identityPage.html)) {
      const links = officialResearchLinkDiagnostics(identityPage.html, identityPage.url, [...HOSTS], 5);
      linksConsidered = links.considered.flatMap(({ url }) => { const safeUrl = safeSource(url); return safeUrl ? [safeUrl] : []; });
      linksSelected = links.selected.flatMap((link) => {
        const safeUrl = safeSource(link.url);
        return safeUrl ? [{ sourceUrl: safeUrl, rank: link.rank, reasons: link.reasons }] : [];
      });
    }
    const researchEvidence = candidate.discoveryEvidence?.find((evidence) => evidence.kind === 'research' && evidence.quote) ??
      candidate.discoveryEvidence?.find((evidence) => evidence.kind === 'professor-profile' && evidence.quote);
    const extractedQuote = researchEvidence?.quote;
    const extractedSource = researchEvidence?.sourceUrl ? safeSource(researchEvidence.sourceUrl) : undefined;
    const fetchedResearchLinks = linksSelected.flatMap((link) => {
      const record = attempts.findLast((attempt) => attempt.sourceUrl === link.sourceUrl);
      return record ? [record] : [];
    });
    const researchPages = pages.filter((page) => linksSelected.some(({ sourceUrl }) => sourceUrl === page.url));
    const evidencePages = [...(identityPage ? [identityPage] : []), ...researchPages];
    const observedResearchExcerpts = evidencePages.flatMap((page) => savedResearchSnippets(page.html).map((excerpt) => ({ sourceUrl: page.url, excerpt })));
    const matched = extractedQuote ? matchingResearchInterests(extractedQuote, interests).length > 0 : null;
    const observedTextMatched = observedResearchExcerpts.length
      ? observedResearchExcerpts.some(({ excerpt }) => matchingResearchInterests(excerpt, interests).length > 0)
      : null;
    const failedResearchFetch = fetchedResearchLinks.some((record) => record.fetchStatus === 'failed');
    const profileFailure = profileFetch.fetchStatus === 'failed';
    const identityEstablished = Boolean(identityEvidence);
    const profileContainsResearchQuote = Boolean(profilePage && extractResearchQuote(profilePage.html));
    const stopReason: SavedPreviewCandidateDiagnostic['stopReason'] = profileFailure
      ? profileFetch.errorCode === 'invalid_content' ? 'unsupported_content' : 'profile_fetch_failed'
      : !identityEstablished ? 'identity_not_established'
        : failure && safeFailureRecord(failure).kind === 'invalid_content' ? 'unsupported_content'
          : failedResearchFetch ? 'research_fetch_failed'
            : !profileContainsResearchQuote && linksSelected.length === 0 ? 'no_research_links'
              : !extractedQuote ? 'no_research_text_extracted'
                : !matched ? 'research_interest_not_matched' : 'passed_all_gates';
    candidates.push({
      recordId: saved.recordId,
      profile: profileFetch,
      identity: { established: identityEstablished, sourceUrl: identitySource, supportingExcerpt: identityExcerpt },
      research: {
        linksConsidered,
        linksSelected,
        linksFetched: fetchedResearchLinks,
        textExtracted: Boolean(extractedQuote),
        ...(extractedQuote && extractedSource ? { extractedSourceUrl: extractedSource, supportingExcerpt: reportText(extractedQuote) } : {}),
        observedResearchExcerpts: observedResearchExcerpts.slice(0, MAX_SAVED_EXCERPTS),
        observedTextMatchedSavedInterests: observedTextMatched,
        matchedSavedInterests: matched,
      },
      stopReason,
    });
  }
  return { generatedAt, institution: OFFICIAL_INSTITUTION_BY_REGION[REGION], inspected: candidates.length, totalPageFetches: attempts.length, candidates };
}

async function savePrivateReport(report: SavedPreviewDiagnosticReport): Promise<string> {
  const folder = resolve(process.cwd(), 'private-data', 'discovery-previews');
  await mkdir(folder, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const reportPath = resolve(folder, `canada-replay-${stamp}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return reportPath;
}

async function readSavedProfile(): Promise<ApplicantProfile> {
  const storage = await connectMongoStorage();
  try {
    const profile = await storage.repositories.profiles.get('primary');
    if (!profile) throw new Error('profile_unavailable');
    return profile;
  } finally { await storage.close(); }
}

async function run(): Promise<void> {
  try {
    const profile = await readSavedProfile();
    const report = await replaySavedPreviewCandidates({ profile });
    const reportPath = await savePrivateReport(report);
    const reasonCounts: Record<string, number> = {};
    for (const candidate of report.candidates) reasonCounts[candidate.stopReason] = (reasonCounts[candidate.stopReason] ?? 0) + 1;
    process.stdout.write(`${JSON.stringify({ ok: true, reportPath, inspected: report.inspected, totalPageFetches: report.totalPageFetches, reasonCounts })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, errorCode: safeFailureRecord(error).kind })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
