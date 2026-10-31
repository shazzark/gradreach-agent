import { createHash } from 'node:crypto';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { DiscoveryEvidence, ProfessorCandidate } from '../domain/outreach-queue.ts';
import { diagnosticResultHostname, type RejectedSearchResultChecks, type SearchProvider, type SearchResult } from '../infrastructure/brave-search-provider.ts';
import type { Phase3ResultDiagnostic } from '../infrastructure/phase3-pilot-diagnostics.ts';
import { failureForHttpStatus, safeFailureRecord, sanitizedIntegrationError, SanitizedIntegrationError, type SafeFailureRecord, type SafeResponseDiagnostics } from '../infrastructure/sanitized-failure.ts';

const PUBLIC_SUFFIXES = new Set([
  'com', 'edu', 'gov', 'mil', 'net', 'org',
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'org.uk', 'plc.uk', 'sch.uk',
  'ac.jp', 'co.jp', 'go.jp', 'or.jp', 'com.au', 'edu.au', 'gov.au', 'net.au', 'org.au',
  'ac.nz', 'co.nz', 'govt.nz', 'net.nz', 'org.nz', 'com.br', 'edu.br', 'gov.br', 'org.br',
  'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn', 'ac.in', 'co.in', 'edu.in', 'gov.in', 'net.in', 'org.in',
]);

export interface CandidateDiscoveryRepository {
  list(): Promise<ProfessorCandidate[]>;
  save(candidate: ProfessorCandidate): Promise<void>;
}

export interface DiscoveryOptions {
  /** Explicitly reviewed official institutional hostnames, keyed by configured profile country. */
  officialHostsByRegion: Record<string, string[]>;
  countryCodesByRegion?: Record<string, string>;
  resultsPerQuery?: number;
  /** Combines a region's reviewed exact hosts into one bounded Brave request. */
  oneSearchPerRegion?: boolean;
  /** Persist only candidates with a named professor and substantive same-page profile evidence. */
  saveOnlyProfessorProfiles?: boolean;
  /** Stops after this many Brave requests; useful for a single bounded pilot. */
  maxSearches?: number;
  targetPoolSize?: number;
  now?: () => Date;
  fetchPage?: (url: string) => Promise<{ url: string; html: string }>;
  onRejectedResult?: (checks: RejectedSearchResultChecks) => void | Promise<void>;
  onResultDiagnostic?: (diagnostic: Phase3ResultDiagnostic) => void | Promise<void>;
  onOfficialPageFailure?: (failure: SafeFailureRecord) => void;
}

function normalizeHost(value: string): string {
  const host = value.toLowerCase().trim().replace(/^\.+|\.+$/g, '');
  const labels = host.split('.');
  if (!host || host.includes('/') || host.includes(':') || host.includes('@') ||
      labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      PUBLIC_SUFFIXES.has(host)) {
    throw new SanitizedIntegrationError('disallowed_host');
  }
  return host;
}

function isAllowedOfficialUrl(value: string, hosts: string[]): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    // Exact host matching avoids implicitly trusting every tenant under a broad suffix.
    return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(hostname);
  } catch {
    return false;
  }
}

function canonicalizeSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|ref|source)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function hasPdfSignature(content: string): boolean {
  return content.slice(0, 1024).includes('%PDF-');
}

export function extractOfficialPageExcerpt(html: string): string {
  return html
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function queryFor(region: string, interest: string, hosts: string[]): string {
  const siteFilter = hosts.length === 1 ? `site:${hosts[0]}` : `(${hosts.map((host) => `site:${host}`).join(' OR ')})`;
  return `${siteFilter} faculty professor supervisor lab laboratory research group ${interest} MSc ${region}`.slice(0, 600);
}

function candidateFor(result: SearchResult, sourceUrl: string, region: string, query: string, retrievedAt: string): ProfessorCandidate {
  const id = `discovery-${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 24)}`;
  const evidence: DiscoveryEvidence = {
    kind: 'search-result',
    sourceUrl,
    excerpt: result.excerpt.slice(0, 1200),
    retrievedAt,
    verification: 'unverified',
    region,
    query,
  };
  return {
    id,
    // Search titles are leads, not confirmed people; review status and evidence label preserve that distinction.
    name: result.title || 'Unreviewed search result',
    institution: '',
    country: '',
    leadType: 'discovery',
    searchRegion: region,
    sourceCheckedAt: retrievedAt,
    discoveryEvidence: [evidence],
    status: 'needs-evidence',
    approvedForSending: false,
    priority: 0,
  };
}

const GENERIC_NAME_WORDS = new Set(['professor', 'faculty', 'staff', 'people', 'research', 'researcher', 'department', 'school', 'university', 'college', 'program', 'programme', 'laboratory', 'lab', 'center', 'centre', 'group', 'institute', 'computer', 'science', 'computing', 'cybersecurity', 'security', 'privacy', 'network', 'networks', 'system', 'systems', 'robotics', 'robot', 'robots', 'artificial', 'intelligence', 'machine', 'learning', 'software', 'engineering', 'cloud', 'distributed', 'autonomous', 'perception', 'contact', 'home']);
const RESEARCH_SENTENCE = /\b(researches|studies|investigates|develops|explores|focuses|works?\s+on)\b/i;

function pageHeading(html: string): string {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1];
  return heading ? extractOfficialPageExcerpt(heading).split(/\s+(?:\||—|–|-)\s+/)[0]?.trim() ?? '' : '';
}

function plausiblePersonName(value: string): string | undefined {
  const name = value.replace(/^(?:professor|prof\.?|dr\.?)\s+/i, '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (name.length > 100 || parts.length < 2 || parts.length > 4 ||
      parts.some((part) => GENERIC_NAME_WORDS.has(part.toLowerCase()) || !/^[\p{L}][\p{L}.'’\-]*$/u.test(part))) return undefined;
  return name;
}

function professorProfileEvidence(html: string): { name: string; quote: string } | undefined {
  const name = plausiblePersonName(pageHeading(html));
  if (!name) return undefined;
  const excerpt = extractOfficialPageExcerpt(html);
  if (!excerpt || !new RegExp(name.split(/\s+/).map(escapeRegex).join('\\s+'), 'i').test(excerpt)) return undefined;
  const contentBlocks = [...html.matchAll(/<(p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
    .map((match) => extractOfficialPageExcerpt(match[2] ?? ''));
  const sentenceText = contentBlocks.length ? contentBlocks.join(' ') : excerpt;
  const quote = sentenceText.split(/(?<=[.!?])\s+/).map((part) => part.trim())
    .find((part) => part.length >= 50 && part.length <= 600 && /[.!?]$/.test(part) && RESEARCH_SENTENCE.test(part));
  return quote && excerpt.includes(quote) ? { name, quote } : undefined;
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Accepts only an address in a semantic block that explicitly names this person. */
function explicitlyAssociatedEmail(html: string, personName: string): string | undefined {
  const namePattern = new RegExp(`\\b${personName.split(/\s+/).map(escapeRegex).join('\\s+')}\\b`, 'i');
  for (const match of html.matchAll(/<(section|article|tr|li|p|address|dd)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const block = match[2] ?? '';
    if (!namePattern.test(extractOfficialPageExcerpt(block))) continue;
    const addresses = [...block.matchAll(/<a\b[^>]*href\s*=\s*(['"])mailto:([^'"?#]+)[^'"]*\1[^>]*>([\s\S]*?)<\/a\s*>/gi)]
      .map((item) => decodeURIComponent(item[2] ?? '').trim())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    const unique = [...new Set(addresses)];
    if (unique.length === 1) return unique[0];
  }
  return undefined;
}

function generalPageType(value: string, url: string): NonNullable<ProfessorCandidate['leadType']> {
  const signal = `${value} ${new URL(url).pathname}`.toLowerCase();
  if (/\b(program|programme|course|degree|study|graduate|master|msc)\b/.test(signal)) return 'program';
  if (/\b(research[-_/ ]?(?:areas?|groups?|centres?|centers?|labs?|laboratories|institutes))\b/.test(signal)) return 'research_area';
  if (/\b(school|department|faculty|college|university)\b/.test(signal)) return 'school';
  return 'discovery';
}

function linksFromHtml(html: string, baseUrl: string, hosts: string[]): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const visibleHtml = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  for (const match of visibleHtml.matchAll(/<a\b[^>]*href\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = match[2];
    if (!href) continue;
    try {
      const url = canonicalizeSourceUrl(new URL(href, baseUrl).toString());
      if (isAllowedOfficialUrl(url, hosts)) {
        links.push({ url, text: extractOfficialPageExcerpt(match[3] ?? '') });
      }
    } catch { /* Ignore malformed links. */ }
  }
  return links;
}

function linkKind(link: { url: string; text: string }): 'program' | 'contact' | undefined {
  const signal = `${link.text} ${new URL(link.url).pathname}`.toLowerCase();
  if (/\b(contact|contact-us|contact details|email|reach me)\b/.test(signal)) return 'contact';
  if (/\b(program|programme|course|degree|study|graduate|master|msc)\b/.test(signal)) return 'program';
  return undefined;
}

/** Fetches one official page with redirect and final-host checks; never returns page instructions as trusted data. */
export async function fetchOfficialPage(url: string, allowedHosts: string[], fetchImpl: typeof fetch = fetch): Promise<{ url: string; html: string }> {
  const hosts = [...new Set(allowedHosts.map(normalizeHost))];
  if (!isAllowedOfficialUrl(url, hosts)) throw new SanitizedIntegrationError('disallowed_host');
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw sanitizedIntegrationError(error, url);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const responseDetails: SafeResponseDiagnostics = {
    responseReceived: true,
    statusCode: response.status,
    contentTypeIsHtml: contentType.toLowerCase().includes('text/html'),
    bodyEmpty: null,
  };
  if (response.status >= 300 && response.status < 400) {
    throw new SanitizedIntegrationError('rejected_redirect', { ...responseDetails, resourceUrl: url });
  }
  if (!response.ok) throw failureForHttpStatus(response.status, url, responseDetails);
  const finalUrl = response.url || url;
  if (!isAllowedOfficialUrl(finalUrl, hosts)) throw new SanitizedIntegrationError('disallowed_host', { ...responseDetails, resourceUrl: url });
  if (contentType && !contentType.toLowerCase().includes('text/html')) {
    throw new SanitizedIntegrationError('invalid_content', { ...responseDetails, resourceUrl: url });
  }
  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    throw sanitizedIntegrationError(error, url, responseDetails);
  }
  if (!html.trim()) throw new SanitizedIntegrationError('invalid_content', { ...responseDetails, bodyEmpty: true, resourceUrl: url });
  if (hasPdfSignature(html)) {
    throw new SanitizedIntegrationError('invalid_content', {
      ...responseDetails,
      contentTypeIsHtml: false,
      bodyEmpty: false,
      resourceUrl: url,
    });
  }
  return { url: canonicalizeSourceUrl(finalUrl), html: html.slice(0, 2_000_000) };
}

/** Fetches the search result and its first same-host program/contact links, storing all evidence unverified. */
export async function enrichOfficialCandidate(candidate: ProfessorCandidate, hosts: string[], options: Pick<DiscoveryOptions, 'fetchPage' | 'now' | 'onOfficialPageFailure'>): Promise<ProfessorCandidate> {
  const fetchPage = options.fetchPage ?? ((url: string) => fetchOfficialPage(url, hosts));
  const loadPage = async (url: string) => {
    let page: { url: string; html: string };
    try {
      page = await fetchPage(url);
    } catch (error) {
      options.onOfficialPageFailure?.(safeFailureRecord(error, url));
      throw sanitizedIntegrationError(error, url);
    }
    if (!isAllowedOfficialUrl(page.url, hosts)) {
      const error = new SanitizedIntegrationError('disallowed_host', { resourceUrl: url });
      options.onOfficialPageFailure?.(error.failure);
      throw error;
    }
    return page;
  };
  const evidence = [...(candidate.discoveryEvidence ?? [])];
  const retrievedAt = () => (options.now?.() ?? new Date()).toISOString();
  const resultUrl = evidence.find((item) => item.kind === 'search-result')?.sourceUrl;
  if (!resultUrl) return candidate;
  const page = await loadPage(resultUrl);
  const profileRetrievedAt = retrievedAt();
  const excerpt = extractOfficialPageExcerpt(page.html);
  const profile = professorProfileEvidence(page.html);
  if (profile) {
    candidate.name = pageHeading(page.html) || candidate.name;
    candidate.professorName = profile.name;
    candidate.leadType = 'professor_profile';
    candidate.officialProfileUrl = page.url;
    const email = explicitlyAssociatedEmail(page.html, profile.name);
    if (email) {
      candidate.officialEmail = email;
      candidate.emailSourceUrl = page.url;
      evidence.push({ kind: 'contact', sourceUrl: page.url, excerpt, retrievedAt: profileRetrievedAt, verification: 'unverified', region: candidate.searchRegion ?? '', query: 'Official page explicitly associates this contact with the named profile' });
    }
    evidence.push({ kind: 'professor-profile', sourceUrl: page.url, excerpt, quote: profile.quote, retrievedAt: profileRetrievedAt, verification: 'unverified', region: candidate.searchRegion ?? '', query: 'Fetched from exact allowlisted official profile URL; evidence remains unreviewed' });
  } else {
    candidate.name = pageHeading(page.html) || candidate.name;
    candidate.leadType = generalPageType(candidate.name, page.url);
    evidence.push({ kind: 'official-page', sourceUrl: page.url, excerpt, retrievedAt: profileRetrievedAt, verification: 'unverified', region: candidate.searchRegion ?? '', query: 'Fetched from exact allowlisted official result URL; page type remains unreviewed' });
  }
  const chosen = new Map<'program' | 'contact', string>();
  for (const link of linksFromHtml(page.html, page.url, hosts)) {
    const kind = linkKind(link);
    if (kind && !chosen.has(kind)) chosen.set(kind, link.url);
  }
  for (const kind of ['program', 'contact'] as const) {
    const url = chosen.get(kind);
    if (!url) continue;
    const linkedPage = await loadPage(url);
    const sourceUrl = linkedPage.url;
    const linkedExcerpt = extractOfficialPageExcerpt(linkedPage.html);
    const linkedAt = retrievedAt();
    evidence.push({ kind, sourceUrl, excerpt: linkedExcerpt, retrievedAt: linkedAt, verification: 'unverified', region: candidate.searchRegion ?? '', query: `Linked from ${page.url}` });
    if (kind === 'program') candidate.programUrl = sourceUrl;
    else {
      candidate.officialContactUrl = sourceUrl;
      if (candidate.leadType === 'professor_profile') {
        const email = explicitlyAssociatedEmail(linkedPage.html, candidate.professorName ?? '');
        if (email) {
          candidate.officialEmail = email;
          candidate.emailSourceUrl = sourceUrl;
        }
      }
    }
  }
  candidate.sourceCheckedAt = profileRetrievedAt;
  candidate.discoveryEvidence = evidence;
  return candidate;
}

/** Records a human review of the fetched official evidence; this does not approve outreach or assert eligibility. */
export function markCandidateEvidenceReviewed(candidate: ProfessorCandidate, reviewedSourceUrls: string[], reviewedProfessorProfileUrl: string, reviewedProfessorName: string): ProfessorCandidate {
  const reviewed = new Set(reviewedSourceUrls.map(canonicalizeSourceUrl));
  const evidence = candidate.discoveryEvidence ?? [];
  const profileUrl = canonicalizeSourceUrl(reviewedProfessorProfileUrl);
  if (evidence.length === 0 || evidence.some((item) => item.verification !== 'reviewed' && !reviewed.has(canonicalizeSourceUrl(item.sourceUrl)))) {
    throw new Error('Every discovery evidence source must be explicitly reviewed');
  }
  if (!reviewed.has(profileUrl) || !evidence.some((item) => ['official-page', 'professor-profile'].includes(item.kind) && canonicalizeSourceUrl(item.sourceUrl) === profileUrl)) {
    throw new Error('The professor profile must be explicitly selected from a reviewed official page');
  }
  if (!reviewedProfessorName.trim()) throw new Error('A professor name confirmed from the reviewed profile is required');
  candidate.discoveryEvidence = evidence.map((item) => ({
    ...item,
    verification: 'reviewed',
    ...(item.kind === 'official-page' && canonicalizeSourceUrl(item.sourceUrl) === profileUrl ? { kind: 'professor-profile' as const } : {}),
  }));
  candidate.officialProfileUrl = profileUrl;
  const confirmedName = reviewedProfessorName.trim();
  const profileEvidence = evidence.find((item) =>
    ['official-page', 'professor-profile'].includes(item.kind) && canonicalizeSourceUrl(item.sourceUrl) === profileUrl,
  );
  const confirmedNamePattern = new RegExp(confirmedName.split(/\s+/).map(escapeRegex).join('\\s+'), 'i');
  const hasSubstantiveResearch = profileEvidence?.excerpt.split(/(?<=[.!?])\s+/).some((sentence) =>
    sentence.length >= 50 && RESEARCH_SENTENCE.test(sentence),
  );
  if (!profileEvidence || !confirmedNamePattern.test(profileEvidence.excerpt) ||
      !confirmedNamePattern.test(candidate.name) || !hasSubstantiveResearch) {
    throw new Error('The selected official profile must identify the confirmed professor and support substantive research');
  }
  candidate.professorName = confirmedName;
  candidate.leadType = 'professor_profile';
  if (candidate.status === 'needs-evidence') candidate.status = 'ready-for-review';
  return candidate;
}

/** Searches every configured country and reviewed institution host, persisting only review-gated leads. */
export async function discoverProfessorCandidates(input: {
  profile: ApplicantProfile;
  provider: SearchProvider;
  repository: CandidateDiscoveryRepository;
  options: DiscoveryOptions;
}): Promise<{ searches: number; saved: number; rejected: number; duplicates: number; validationRejections: number; officialPageFetchFailures: number; rejectedByCheck: { exactHost: number; title: number; excerpt: number }; poolSize: number; targetReached: boolean }> {
  const targetPoolSize = input.options.targetPoolSize ?? 200;
  if (!Number.isInteger(targetPoolSize) || targetPoolSize < 1 || targetPoolSize > 200) {
    throw new Error('targetPoolSize must be an integer from 1 to 200');
  }
  const existingCandidates = await input.repository.list();
  const knownIds = new Set(existingCandidates.map((candidate) => candidate.id));
  const knownUrls = new Set(existingCandidates.flatMap((candidate) => (candidate.discoveryEvidence ?? [])
    .filter((item) => item.kind === 'search-result')
    .map((item) => canonicalizeSourceUrl(item.sourceUrl))));
  let poolSize = knownIds.size;
  if (poolSize >= targetPoolSize) {
    return { searches: 0, saved: 0, rejected: 0, duplicates: 0, validationRejections: 0, officialPageFetchFailures: 0, rejectedByCheck: { exactHost: 0, title: 0, excerpt: 0 }, poolSize, targetReached: true };
  }
  const regions = [...new Set(input.profile.applicant.target.countries.map((country) => country.trim()).filter(Boolean))];
  if (regions.length === 0) throw new Error('At least one configured target country is required for discovery');
  const interests = [...new Set([...input.profile.applicant.target.fields, ...input.profile.applicant.target.researchInterests]
    .map((item) => item.trim()).filter(Boolean))];
  if (interests.length === 0) throw new Error('At least one configured academic field or research interest is required');

  let searches = 0;
  let saved = 0;
  let rejected = 0;
  let duplicates = 0;
  let validationRejections = 0;
  let officialPageFetchFailures = 0;
  const rejectedByCheck = { exactHost: 0, title: 0, excerpt: 0 };
  const seenUrls = new Set<string>(knownUrls);
  const maxSearches = input.options.maxSearches ?? Number.POSITIVE_INFINITY;
  if (!(maxSearches === Number.POSITIVE_INFINITY || Number.isInteger(maxSearches) && maxSearches > 0)) throw new Error('maxSearches must be a positive integer');
  discovery: for (const region of regions) {
    const configuredHosts = input.options.officialHostsByRegion[region];
    if (!configuredHosts?.length) throw new Error(`No reviewed official institution hosts configured for region: ${region}`);
    const hosts = [...new Set(configuredHosts.map(normalizeHost))];
    const hostGroups = input.options.oneSearchPerRegion ? [hosts] : hosts.map((host) => [host]);
    for (const matchingHosts of hostGroups) {
      for (const interest of interests) {
        if (searches >= maxSearches) break discovery;
        const query = queryFor(region, interest, matchingHosts);
        const recordRejection = async (checks: RejectedSearchResultChecks) => {
          rejected += 1;
          validationRejections += 1;
          if (checks.exactHost) rejectedByCheck.exactHost += 1;
          if (checks.title) rejectedByCheck.title += 1;
          if (checks.excerpt) rejectedByCheck.excerpt += 1;
          await input.options.onRejectedResult?.(checks);
          await input.options.onResultDiagnostic?.({
            country: region,
            hostname: checks.hostname,
            outcome: 'rejected',
            rejectionReasons: [
              ...(checks.exactHost ? ['exact_host'] : []),
              ...(checks.title ? ['title'] : []),
              ...(checks.excerpt ? ['excerpt'] : []),
            ],
          });
        };
        const results = await input.provider.search(query, {
          ...(input.options.countryCodesByRegion?.[region] ? { countryCode: input.options.countryCodesByRegion[region] } : {}),
          count: input.options.resultsPerQuery ?? 10,
          ...(input.options.onRejectedResult || input.options.onResultDiagnostic ? { onRejectedResult: recordRejection } : {}),
        });
        searches += 1;
        const retrievedAt = (input.options.now?.() ?? new Date()).toISOString();
        for (const result of results) {
          const failedChecks = {
            exactHost: !isAllowedOfficialUrl(result.url, matchingHosts),
            title: !result.title.trim(),
            excerpt: !result.excerpt.trim(),
            hostname: diagnosticResultHostname(result.url),
          };
          if (failedChecks.exactHost || failedChecks.title || failedChecks.excerpt) {
            await recordRejection(failedChecks);
            continue;
          }
          const canonicalUrl = canonicalizeSourceUrl(result.url);
          if (seenUrls.has(canonicalUrl)) {
            duplicates += 1;
            await input.options.onResultDiagnostic?.({ country: region, hostname: failedChecks.hostname, outcome: 'duplicate', rejectionReasons: [] });
            continue;
          }
          seenUrls.add(canonicalUrl);
          const candidate = candidateFor(result, canonicalUrl, region, query, retrievedAt);
          if (knownIds.has(candidate.id)) {
            duplicates += 1;
            await input.options.onResultDiagnostic?.({ country: region, hostname: failedChecks.hostname, outcome: 'duplicate', rejectionReasons: [] });
            continue;
          }
          try {
            await enrichOfficialCandidate(candidate, matchingHosts, input.options);
          } catch (error) {
            // A bad or unavailable official page rejects this lead, but should not discard later results.
            if (error instanceof SanitizedIntegrationError) {
              officialPageFetchFailures += 1;
              await input.options.onResultDiagnostic?.({
                country: region,
                hostname: error.failure.resourceHost ?? failedChecks.hostname,
                outcome: 'fetch_failed',
                rejectionReasons: [error.failure.kind],
                ...(error.failure.resourcePath ? { resourcePath: error.failure.resourcePath } : {}),
                ...(error.failure.statusCode ? { statusCode: error.failure.statusCode } : {}),
                ...(error.failure.errorName ? { errorName: error.failure.errorName } : {}),
                ...(error.failure.errorCode ? { errorCode: error.failure.errorCode } : {}),
                ...(error.failure.causeName ? { causeName: error.failure.causeName } : {}),
                ...(error.failure.causeCode ? { causeCode: error.failure.causeCode } : {}),
              });
              continue;
            }
            throw error;
          }
          const professorEvidence = candidate.discoveryEvidence?.find((item) =>
            item.kind === 'professor-profile' && item.sourceUrl === candidate.officialProfileUrl &&
            item.verification === 'unverified' && Boolean(item.quote?.trim()),
          );
          if (input.options.saveOnlyProfessorProfiles &&
              (candidate.leadType !== 'professor_profile' || !candidate.officialProfileUrl || !professorEvidence)) {
            rejected += 1;
            validationRejections += 1;
            await input.options.onResultDiagnostic?.({
              country: region,
              hostname: failedChecks.hostname,
              outcome: 'rejected',
              rejectionReasons: ['not_professor_profile'],
            });
            continue;
          }
          await input.options.onResultDiagnostic?.({ country: region, hostname: failedChecks.hostname, outcome: 'page_validated', rejectionReasons: [] });
          await input.repository.save(candidate);
          knownIds.add(candidate.id);
          poolSize += 1;
          saved += 1;
          if (poolSize >= targetPoolSize) break discovery;
        }
      }
    }
  }
  return { searches, saved, rejected, duplicates, validationRejections, officialPageFetchFailures, rejectedByCheck, poolSize, targetReached: poolSize >= targetPoolSize };
}
