import { createHash } from 'node:crypto';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { DiscoveryEvidence, ProfessorCandidate } from '../domain/outreach-queue.ts';
import { diagnosticResultHostname, isVerifiedBraveCountryCode, type RejectedSearchResultChecks, type SearchProvider, type SearchResult } from '../infrastructure/brave-search-provider.ts';
import type { Phase3ResultDiagnostic, ProfessorTraversalDiagnostics } from '../infrastructure/phase3-pilot-diagnostics.ts';
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

export type CandidatePreviewReason =
  | 'invalid_search_result'
  | 'duplicate_saved_lead'
  | 'duplicate_official_profile'
  | 'official_page_fetch_failed'
  | 'page_fetch_limit'
  | 'identity_not_established'
  | 'research_evidence_missing'
  | 'research_interest_mismatch'
  | 'passed_all_gates';

export type DiscoveryQueryType = 'general' | 'faculty_directory' | 'professor_profile' | 'research_group' | 'research_topic';

export interface CandidatePreviewOutcome {
  resultNumber: number;
  name: string;
  identityVerified: boolean;
  outcome: 'passed' | 'stopped';
  reasonCode: CandidatePreviewReason;
  officialProfileSource?: string;
  supportingResearch: Array<{ sourceUrl: string; quote: string }>;
}

export interface DiscoveryOptions {
  /** Explicitly reviewed official institutional hostnames, keyed by configured profile country. */
  officialHostsByRegion: Record<string, string[]>;
  countryCodesByRegion?: Record<string, string>;
  resultsPerQuery?: number;
  /** Focused query variants; defaults to the historical single general query. */
  searchQueryTypes?: DiscoveryQueryType[];
  /** Brave result pages fetched for each focused query, up to its API maximum of ten. */
  maxPagesPerQuery?: number;
  /** Combines a region's reviewed exact hosts into one bounded Brave request. */
  oneSearchPerRegion?: boolean;
  /** Combines saved interests into one query per country, preserving country order. */
  oneQueryPerRegion?: boolean;
  /** Persist only candidates with a named professor and substantive allowlisted official research evidence. */
  saveOnlyProfessorProfiles?: boolean;
  /** Applies an additional deterministic evidence gate before any candidate write. */
  shouldSaveCandidate?: (candidate: ProfessorCandidate) => boolean;
  /** Stops after this many Brave requests; useful for a single bounded pilot. */
  maxSearches?: number;
  /** Limits all official-page requests, including directories and linked evidence pages, for one run. */
  maxPageFetchesPerRun?: number;
  /** Maximum number of linked official research pages selected for one individual profile. */
  maxResearchPagesPerProfile?: number;
  /** Additional official profile URLs found in an earlier preview country in this local run. */
  additionalKnownOfficialProfileUrls?: string[];
  /** Controls optional program/contact link inspection after identity and research evidence pass. */
  followSupplementaryLinks?: boolean;
  /** Skips email extraction when only research evidence is needed, such as a private preview. */
  collectContactEmail?: boolean;
  targetPoolSize?: number;
  now?: () => Date;
  fetchPage?: (url: string) => Promise<{ url: string; html: string }>;
  onRejectedResult?: (checks: RejectedSearchResultChecks, resultNumber?: number) => void | Promise<void>;
  onSearchTargeting?: (target: { country: string; mode: 'api_country' | 'query_and_host' }) => void | Promise<void>;
  onProfessorEvidenceFailure?: (reason: 'no_named_professor_identity' | 'no_official_research_evidence') => void;
  onProfessorIdentity?: (identity: { name: string; officialProfileUrl: string }) => void;
  onProfessorTraversalDiagnostic?: (diagnostic: ProfessorTraversalDiagnostics) => void;
  onResultDiagnostic?: (diagnostic: Phase3ResultDiagnostic) => void | Promise<void>;
  onRedirect?: (diagnostic: Phase3ResultDiagnostic) => void | Promise<void>;
  onOfficialPageFailure?: (failure: SafeFailureRecord) => void;
  /** Emits a minimized in-memory result for a local preview; callers decide how to store it. */
  onCandidatePreview?: (outcome: CandidatePreviewOutcome) => void | Promise<void>;
  onCoverageStop?: (reason: 'search_request_budget_exhausted' | 'pagination_budget_exhausted' | 'pagination_metadata_unavailable' | 'page_inspection_budget_exhausted') => void;
}

/** The traversal may inspect this many same-host profile pages for one directory result. */
export const MAX_SAME_HOST_PROFILE_PAGES_PER_DIRECTORY = 10;
export const MAX_OFFICIAL_PAGE_FETCHES_PER_RUN = 30;
export const MAX_LINKED_RESEARCH_PAGES_PER_PROFILE = 5;
const MAX_PROFILE_LINKS_TO_RANK = 100;
const PROFILE_SELECTION_REASON_CODES = ['named_link_text', 'named_faculty_context', 'profile_url_pattern', 'faculty_card_context', 'profile_label', 'academic_role'] as const;
type ProfileSelectionReason = typeof PROFILE_SELECTION_REASON_CODES[number];

export class DiscoveryPageFetchBudgetReached extends Error {}

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

export function canonicalizeSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|ref|source|token|access_token|auth|authorization|code|key|secret|signature|sig|session|sessionid|sid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function hasPdfSignature(content: string): boolean {
  return content.slice(0, 1024).includes('%PDF-');
}

export function extractOfficialPageExcerpt(html: string, maximum = 1200): string {
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
    .slice(0, maximum);
}

function queryFor(region: string, interest: string, hosts: string[], queryType: DiscoveryQueryType = 'general'): string {
  const siteFilter = hosts.length === 1 ? `site:${hosts[0]}` : `(${hosts.map((host) => `site:${host}`).join(' OR ')})`;
  // Use alternatives so a directory or an individual profile can rank without requiring every generic term.
  const focusedTerms: Record<DiscoveryQueryType, string> = {
    general: '(faculty directory OR professor profile)',
    faculty_directory: '("faculty directory" OR "faculty members" OR "academic staff")',
    professor_profile: '("professor profile" OR "faculty profile" OR "assistant professor")',
    research_group: '("research group" OR laboratory OR labs)',
    research_topic: '("research interests" OR "research topics" OR publications)',
  };
  const coreTerms = [siteFilter, focusedTerms[queryType], 'research'];
  const closingTerms = ['MSc', region];
  const interestTerms = interest.trim().split(/\s+/).filter(Boolean);
  const selectedInterestTerms: string[] = [];
  const compose = (terms: string[]) => [...coreTerms, ...terms, ...closingTerms].join(' ');

  for (const term of interestTerms) {
    const candidate = compose([...selectedInterestTerms, term]);
    if (candidate.length > 400 || candidate.split(/\s+/).length > 50) {
      if (selectedInterestTerms.at(-1)?.toUpperCase() === 'OR') selectedInterestTerms.pop();
      break;
    }
    selectedInterestTerms.push(term);
  }
  if (selectedInterestTerms.at(-1)?.toUpperCase() === 'OR') selectedInterestTerms.pop();

  const query = compose(selectedInterestTerms);
  if (query.length > 400 || query.split(/\s+/).length > 50) {
    throw new SanitizedIntegrationError('invalid_request');
  }
  return query;
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

const GENERIC_NAME_WORDS = new Set(['academic', 'advising', 'quick', 'facts', 'information', 'overview', 'about', 'professor', 'faculty', 'staff', 'people', 'research', 'researcher', 'department', 'school', 'university', 'college', 'program', 'programme', 'laboratory', 'lab', 'center', 'centre', 'group', 'institute', 'computer', 'science', 'computing', 'cybersecurity', 'security', 'privacy', 'network', 'networks', 'system', 'systems', 'robotics', 'robot', 'robots', 'artificial', 'intelligence', 'machine', 'learning', 'software', 'engineering', 'cloud', 'distributed', 'autonomous', 'perception', 'contact', 'home', 'view', 'profile', 'biography', 'personal', 'page', 'details', 'more']);
const RESEARCH_SENTENCE = /\b(researches|studies(?!\s+(?:application|program|programme|degree|course|students))|investigates|develops|explores|focuses|works?\s+on|research\s+spans)\b/i;

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

export function extractProfessorIdentityEvidence(html: string): { name: string; identityQuote: string } | undefined {
  const name = plausiblePersonName(pageHeading(html));
  if (!name) return undefined;
  const excerpt = extractOfficialPageExcerpt(html);
  const namePattern = new RegExp(name.split(/\s+/).map(escapeRegex).join('\\s+'), 'i');
  // "Academic" describes a broad service area as often as an individual's role (for example, Academic Advising).
  const rolePattern = /\b(professor|lecturer|faculty member|researcher|postdoctoral fellow|postdoctoral researcher|principal investigator|instructor)\b/i;
  const roleBlock = [...html.matchAll(/<(p|li|h[1-6]|dt|dd|span|div)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
    .map((match) => extractOfficialPageExcerpt(match[2] ?? ''))
    .find((text) => rolePattern.test(text));
  if (!excerpt || !namePattern.test(excerpt) || !roleBlock) return undefined;
  const heading = pageHeading(html);
  return { name, identityQuote: (roleBlock === heading ? heading : `${heading} — ${roleBlock}`).slice(0, 400) };
}

export function extractResearchQuote(html: string): string | undefined {
  // Research statements can appear after long institutional navigation on a profile page.
  const excerpt = extractOfficialPageExcerpt(html, 2_000_000);
  if (!excerpt) return undefined;
  const contentBlocks = [...html.matchAll(/<(p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
    .map((match) => extractOfficialPageExcerpt(match[2] ?? ''));
  const sentenceBlocks = contentBlocks.length ? contentBlocks : [excerpt];
  const sentences = sentenceBlocks.flatMap((block) => block.replace(/\b(Dr|Prof|Mr|Mrs|Ms)\./gi, '$1\uE000')
    .split(/(?<=[.!?])\s+/).map((part) => part.replace(/\uE000/g, '.').trim()));
  const quote = sentences
    .find((part) => part.length >= 50 && part.length <= 600 && /[.!?]$/.test(part) && RESEARCH_SENTENCE.test(part));
  return quote && excerpt.includes(quote) ? quote : undefined;
}

export function extractProfessorProfileEvidence(html: string): { name: string; quote: string; identityQuote: string } | undefined {
  const identity = extractProfessorIdentityEvidence(html);
  const quote = extractResearchQuote(html);
  return identity && quote ? { ...identity, quote } : undefined;
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizePersonName(value: string): string { return value.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

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

type OfficialLink = { url: string; text: string; nearbyText: string };
type ResearchSelectionReason = 'research_anchor_text' | 'research_url_pattern' | 'research_section_context';

function nearbyCardText(html: string, anchorOffset: number, anchorEnd: number): string {
  const contextStart = Math.max(0, anchorOffset - 2_000);
  const contextEnd = Math.min(html.length, anchorEnd + 2_000);
  const contextHtml = html.slice(contextStart, contextEnd);
  const localAnchorOffset = anchorOffset - contextStart;
  const localAnchorEnd = anchorEnd - contextStart;
  const tagPattern = /<\/?([a-z][a-z0-9:-]*)\b[^>]*>/gi;
  const stack: Array<{ name: string; start: number; openingTag: string }> = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(contextHtml)) && tag.index < localAnchorOffset) {
    const token = tag[0];
    const name = (tag[1] ?? '').toLowerCase();
    if (token.startsWith('</')) {
      const index = stack.map((item) => item.name).lastIndexOf(name);
      if (index >= 0) stack.splice(index);
    } else if (!voidTags.has(name) && !token.endsWith('/>')) {
      stack.push({ name, start: tag.index, openingTag: token });
    }
  }

  const card = [...stack].reverse().find(({ name, openingTag }) =>
    ['article', 'li', 'tr'].includes(name) ||
    (['div', 'section'].includes(name) && /\b(?:faculty|person|profile|staff|member|card|views-row|list-row|research|publication|project|laborator|laboratory|lab|group)\b/i.test(openingTag)));
  if (!card) return extractOfficialPageExcerpt(
    contextHtml.slice(Math.max(0, localAnchorOffset - 40), Math.min(contextHtml.length, localAnchorEnd + 40))
      .replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, ' '),
  );

  const matchingTag = new RegExp(`<\\/?${card.name}\\b[^>]*>`, 'gi');
  matchingTag.lastIndex = card.start;
  let depth = 0;
  let cardEnd = html.length;
  let match: RegExpExecArray | null;
  while ((match = matchingTag.exec(contextHtml))) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (!match[0].endsWith('/>')) depth += 1;
    if (depth === 0) { cardEnd = match.index + match[0].length; break; }
  }
  return extractOfficialPageExcerpt(contextHtml.slice(card.start, Math.max(cardEnd, localAnchorEnd)).slice(0, 4_000));
}

function linksFromHtml(html: string, baseUrl: string, hosts: string[]): OfficialLink[] {
  const links: OfficialLink[] = [];
  const visibleHtml = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  for (const match of visibleHtml.matchAll(/<a\b[^>]*href\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = match[2];
    if (!href) continue;
    try {
      const url = canonicalizeSourceUrl(new URL(href, baseUrl).toString());
      if (isAllowedOfficialUrl(url, hosts)) {
        const anchor = match[0];
        const explicitLabel = [
          anchor.match(/\b(?:aria-label|title)\s*=\s*(['"])(.*?)\1/i)?.[2],
          extractOfficialPageExcerpt(match[3] ?? ''),
        ].filter(Boolean).join(' ');
        const offset = match.index ?? 0;
        const text = explicitLabel.slice(0, 300);
        links.push({ url, text, nearbyText: nearbyCardText(visibleHtml, offset, offset + anchor.length) });
      }
    } catch { /* Ignore malformed links. */ }
  }
  return links;
}

function linkKind(link: { url: string; text: string; nearbyText?: string }): 'program' | 'contact' | 'research' | undefined {
  const signal = `${link.text} ${new URL(link.url).pathname.replace(/[-_/]+/g, ' ')} ${link.nearbyText ?? ''}`.toLowerCase();
  if (/\b(subscribe|unsubscribe|newsletter|mailing[-_ ]list)\b|(?:^|\/)ci_mail(?:\/|$)/.test(signal)) return undefined;
  if (/\b(contact|contact-us|contact details|email|reach me)\b/.test(signal)) return 'contact';
  if (/\b(research|research areas?|research group|research interests?|laborator(?:y|ies)|labs?|group|publications?|projects?)\b/.test(signal)) return 'research';
  if (/\b(program|programme|course|degree|study|graduate|master|msc)\b/.test(signal)) return 'program';
  return undefined;
}

function uniqueOfficialLinks(links: OfficialLink[]): OfficialLink[] {
  const unique = new Map<string, OfficialLink>();
  for (const link of links) if (!unique.has(link.url)) unique.set(link.url, link);
  return [...unique.values()];
}

function researchLinkSelection(link: OfficialLink): { score: number; reasons: ResearchSelectionReason[] } {
  const path = new URL(link.url).pathname.replace(/[-_/]+/g, ' ');
  const reasons: ResearchSelectionReason[] = [];
  let score = 0;
  if (/\b(research|research areas?|research group|research interests?|publications?|projects?|laborator(?:y|ies)|labs?)\b/i.test(link.text)) {
    reasons.push('research_anchor_text'); score += 40;
  }
  if (/\b(research|publications?|projects?|laborator(?:y|ies)|labs?|groups?)\b/i.test(path)) {
    reasons.push('research_url_pattern'); score += 30;
  }
  if (/\b(research|research areas?|research group|research interests?|laborator(?:y|ies)|labs?|publications?|projects?)\b/i.test(link.nearbyText)) {
    reasons.push('research_section_context'); score += 50;
  }
  return { score, reasons };
}

function rankResearchLinks(links: OfficialLink[]): Array<OfficialLink & { rank: number; selectionReasons: ResearchSelectionReason[] }> {
  return uniqueOfficialLinks(links).map((link) => ({ link, selection: researchLinkSelection(link) }))
    .filter(({ link, selection }) => linkKind(link) === 'research' && selection.score > 0 && researchLinkRejectionReason(link) !== 'non_research_destination')
    .sort((left, right) => right.selection.score - left.selection.score || left.link.url.localeCompare(right.link.url))
    .map(({ link, selection }, index) => ({ ...link, rank: index + 1, selectionReasons: selection.reasons }));
}

export function officialResearchLinkDiagnostics(html: string, pageUrl: string, hosts: string[], maximumSelected = MAX_LINKED_RESEARCH_PAGES_PER_PROFILE) {
  const considered = uniqueOfficialLinks(linksFromHtml(html, pageUrl, hosts)).slice(0, 100);
  const ranked = rankResearchLinks(considered);
  return {
    considered,
    ranked,
    selected: ranked.slice(0, maximumSelected).map(({ url, rank, selectionReasons }) => ({ url, rank, reasons: [...selectionReasons] })),
    found: ranked.length,
  };
}

function researchLinkRejectionReason(link: OfficialLink): 'non_research_destination' | 'no_research_signal' {
  const signal = `${link.text} ${new URL(link.url).pathname.replace(/[-_/]+/g, ' ')}`;
  return /\b(news|event|contact|login|admin|student|newsletter|subscribe)\b/i.test(signal)
    ? 'non_research_destination'
    : 'no_research_signal';
}

function profileLinkRejectionReason(link: { url: string; text: string; nearbyText?: string }): 'excluded_navigation_or_nonacademic' | 'insufficient_profile_signals' | undefined {
  const pathAndContext = `${link.text} ${new URL(link.url).pathname} ${'nearbyText' in link ? link.nearbyText : ''}`;
  if (/\b(student|undergraduate|graduate student|admin(?:istration)?|news|contact|login|sign[ -]?in|staff directory|directory home)\b/i.test(pathAndContext)) return 'excluded_navigation_or_nonacademic';
  return undefined;
}

function isPotentialProfessorProfileLink(link: { url: string; text: string; nearbyText?: string }): boolean {
  if (profileLinkRejectionReason(link)) return false;
  if (plausiblePersonName(link.text)) return true;
  const pathname = new URL(link.url).pathname.replace(/\/+$/, '');
  const individualRoute = /(?:^|\/)(?:people|person|faculty|staff|professors?|researchers?|academic-staff|teams?|profiles?|directory)\/[^/]+(?:\/[^/]+)?$/i;
  return individualRoute.test(pathname) || /\b(?:view|individual|personal)\s+(?:faculty\s+)?profile\b|\bprofile\b/i.test(link.text);
}

function profileLinkSelection(link: OfficialLink): { score: number; reasons: ProfileSelectionReason[] } {
  const path = new URL(link.url).pathname;
  const reasons: ProfileSelectionReason[] = [];
  let score = 0;
  if (plausiblePersonName(link.text)) { reasons.push('named_link_text'); score += 100; }
  if (/\/(?:people|person|faculty|staff|professors?|researchers?|academic-staff|profiles?|directory)\/[^/]+(?:\/[^/]+)?\/?$/i.test(path)) {
    reasons.push('profile_url_pattern'); score += 45;
  }
  const facultyContext = /\b(?:professor|faculty|academic staff|lecturer|researcher|faculty member|academic)\b/i.test(link.nearbyText);
  if (facultyContext) { reasons.push('faculty_card_context'); score += 35; }
  if (facultyContext && /\b(?:dr\.?|prof\.?|professor)\s+[\p{L}][\p{L}.'’\-]+(?:\s+[\p{L}][\p{L}.'’\-]+){1,3}/iu.test(link.nearbyText)) {
    reasons.push('named_faculty_context'); score += 60;
  }
  if (/\bprofile\b/i.test(link.text)) { reasons.push('profile_label'); score += 10; }
  if (/\b(professor|lecturer|academic|researcher|faculty member|principal investigator)\b/i.test(link.nearbyText)) { reasons.push('academic_role'); score += 40; }
  return { score, reasons };
}

function rankProfileLinks(links: OfficialLink[]): Array<OfficialLink & { rank: number; selectionReasons: ProfileSelectionReason[] }> {
  const unique = new Map<string, OfficialLink>();
  for (const link of links) if (!unique.has(link.url)) unique.set(link.url, link);
  return [...unique.values()].map((link) => ({ link, selection: profileLinkSelection(link) }))
    .filter(({ selection }) => selection.score > 0)
    .sort((left, right) => right.selection.score - left.selection.score || left.link.url.localeCompare(right.link.url))
    .slice(0, MAX_PROFILE_LINKS_TO_RANK)
    .map(({ link, selection }, index) => ({ ...link, rank: index + 1, selectionReasons: selection.reasons }));
}

/** Fetches one official page with redirect and final-host checks; never returns page instructions as trusted data. */
export async function fetchOfficialPage(
  url: string,
  allowedHosts: string[],
  fetchImpl: typeof fetch = fetch,
  onRedirect?: (statusCode: number, destinationHost: string, destinationPath: string) => void | Promise<void>,
): Promise<{ url: string; html: string }> {
  const hosts = [...new Set(allowedHosts.map(normalizeHost))];
  if (!isAllowedOfficialUrl(url, hosts)) throw new SanitizedIntegrationError('disallowed_host');
  const initialUrl = new URL(url);
  initialUrl.hash = '';
  let currentUrl = initialUrl.toString();
  const visited = new Set<string>();
  let response: Response;
  let contentType: string;
  let responseDetails: SafeResponseDiagnostics;
  for (let hop = 0; ; hop += 1) {
    if (visited.has(currentUrl)) throw new SanitizedIntegrationError('rejected_redirect', { resourceUrl: currentUrl });
    visited.add(currentUrl);
    try {
      // No cookies or authorization are used; every hop is checked before this header-only request.
      response = await fetchImpl(currentUrl, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw sanitizedIntegrationError(error, currentUrl);
    }
    contentType = response.headers.get('content-type') ?? '';
    responseDetails = {
      responseReceived: true,
      statusCode: response.status,
      contentTypeIsHtml: contentType.toLowerCase().includes('text/html'),
      bodyEmpty: null,
    };
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    let destination: URL | undefined;
    try { if (location) destination = new URL(location, currentUrl); } catch { /* Keep only the redirect response diagnostics. */ }
    if (destination) destination.hash = '';
    const destinationAllowed = destination !== undefined && isAllowedOfficialUrl(destination.toString(), hosts);
    const destinationDetails = destination && !destination.username && !destination.password
      ? { redirectDestinationHost: destination.hostname.toLowerCase(), redirectDestinationPath: destination.pathname }
      : {};
    if (!destinationAllowed || hop >= 4 || visited.has(destination!.toString())) {
      throw new SanitizedIntegrationError(destinationAllowed ? 'rejected_redirect' : 'disallowed_host', {
        ...responseDetails, ...destinationDetails, resourceUrl: currentUrl,
      });
    }
    await onRedirect?.(response.status, destination!.hostname.toLowerCase(), destination!.pathname);
    if (destination!.hostname.toLowerCase() !== new URL(currentUrl).hostname.toLowerCase()) {
      // Query parameters can carry credentials; do not pass any across an institutional host boundary.
      destination!.search = '';
    }
    currentUrl = destination!.toString();
  }
  if (!response.ok) throw failureForHttpStatus(response.status, currentUrl, responseDetails);
  const finalUrl = response.url || currentUrl;
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

/** Follows bounded official faculty/profile/research links and stores extracted evidence unverified. */
export async function enrichOfficialCandidate(candidate: ProfessorCandidate, hosts: string[], options: Pick<DiscoveryOptions, 'fetchPage' | 'now' | 'maxResearchPagesPerProfile' | 'followSupplementaryLinks' | 'collectContactEmail' | 'onOfficialPageFailure' | 'onRedirect' | 'onProfessorEvidenceFailure' | 'onProfessorIdentity' | 'onProfessorTraversalDiagnostic'> & { pageFetchBudget?: { remaining: number } }): Promise<ProfessorCandidate> {
  const traversal: ProfessorTraversalDiagnostics = {
    directoryPageFetched: false,
    sameHostProfileLinksFound: 0,
    sameHostProfileLinksConsidered: 0,
    sameHostProfileLinksFetched: 0,
    selectedProfileLinks: [],
    professorIdentityEstablished: false,
    linkedResearchPagesConsidered: 0,
    linkedResearchPagesFound: 0,
    linkedResearchPagesSelected: [],
    linkedResearchPagesFetched: 0,
    relevantOfficialResearchEvidenceEstablished: false,
  };
  const reportTraversal = () => options.onProfessorTraversalDiagnostic?.({ ...traversal });
  const fetchPage = options.fetchPage ?? ((url: string) => fetchOfficialPage(url, hosts, fetch, async (statusCode, destinationHost, destinationPath) => {
    await options.onRedirect?.({
      stage: 'official_page_fetch', country: candidate.searchRegion ?? candidate.country,
      hostname: new URL(url).hostname.toLowerCase(), outcome: 'redirect_followed', rejectionReasons: [],
      statusCode, redirectDestinationHost: destinationHost, redirectDestinationPath: destinationPath,
    });
  }));
  const loadPage = async (url: string) => {
    let page: { url: string; html: string };
    if (options.pageFetchBudget) {
      if (options.pageFetchBudget.remaining <= 0) throw new DiscoveryPageFetchBudgetReached();
      options.pageFetchBudget.remaining -= 1;
    }
    try {
      page = await fetchPage(url);
    } catch (error) {
      options.onOfficialPageFailure?.(safeFailureRecord(error, url));
      reportTraversal();
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
  let page = await loadPage(resultUrl);
  const directoryPage = page;
  const directoryExcerpt = extractOfficialPageExcerpt(page.html);
  let profileIdentity = extractProfessorIdentityEvidence(page.html);
  // A non-identity result page is treated as a possible directory source for link traversal.
  traversal.directoryPageFetched = !profileIdentity;
  traversal.professorIdentityEstablished = Boolean(profileIdentity);
  if (profileIdentity) options.onProfessorIdentity?.({ name: profileIdentity.name, officialProfileUrl: page.url });
  let researchPage = page;
  let researchQuote = extractResearchQuote(page.html);
  reportTraversal();

  // A directory is only a source of links. Confirm each name on its linked official profile.
  if (!profileIdentity) {
    const directoryLinks = linksFromHtml(page.html, page.url, hosts);
    const directoryHost = new URL(page.url).hostname.toLowerCase();
    const sameHostLinks = uniqueOfficialLinks(directoryLinks.filter((link) => new URL(link.url).hostname.toLowerCase() === directoryHost))
      .slice(0, MAX_PROFILE_LINKS_TO_RANK);
    const sameHostProfileLinks = sameHostLinks.filter(isPotentialProfessorProfileLink);
    const excludedLinks = sameHostLinks.filter((link) => profileLinkRejectionReason(link) === 'excluded_navigation_or_nonacademic').length;
    const weakSignalLinks = sameHostLinks.length - sameHostProfileLinks.length - excludedLinks;
    const rankedProfileLinks = rankProfileLinks(sameHostProfileLinks);
    traversal.sameHostProfileLinksFound = sameHostProfileLinks.length;
    traversal.sameHostProfileLinksConsidered = sameHostLinks.length;
    const profileLinkRejections = [
      ...(excludedLinks ? [{ reason: 'excluded_navigation_or_nonacademic' as const, count: excludedLinks }] : []),
      ...(weakSignalLinks ? [{ reason: 'insufficient_profile_signals' as const, count: weakSignalLinks }] : []),
    ];
    if (profileLinkRejections.length) traversal.profileLinkRejections = profileLinkRejections;
    traversal.selectedProfileLinks = rankedProfileLinks.slice(0, MAX_SAME_HOST_PROFILE_PAGES_PER_DIRECTORY)
      .map(({ rank, selectionReasons }) => ({ rank, reasons: [...selectionReasons] }));
    reportTraversal();
    const namedProfiles = rankedProfileLinks.slice(0, MAX_SAME_HOST_PROFILE_PAGES_PER_DIRECTORY);
    for (const link of namedProfiles) {
      const linkedProfile = await loadPage(link.url);
      traversal.sameHostProfileLinksFetched += 1;
      reportTraversal();
      const linkedIdentity = extractProfessorIdentityEvidence(linkedProfile.html);
      const linkedName = plausiblePersonName(link.text);
      if (!linkedIdentity || (linkedName && normalizePersonName(linkedName) !== normalizePersonName(linkedIdentity.name))) continue;
      page = linkedProfile;
      profileIdentity = linkedIdentity;
      traversal.professorIdentityEstablished = true;
      options.onProfessorIdentity?.({ name: linkedIdentity.name, officialProfileUrl: page.url });
      researchQuote = extractResearchQuote(page.html);
      researchPage = page;
      reportTraversal();
      break;
    }
  }

  // Research evidence may live on a linked university research page, but must quote that page directly.
  if (profileIdentity && !researchQuote) {
    const researchLinkAudit = officialResearchLinkDiagnostics(page.html, page.url, hosts, options.maxResearchPagesPerProfile ?? MAX_LINKED_RESEARCH_PAGES_PER_PROFILE);
    const officialLinks = researchLinkAudit.considered;
    const researchLinks = researchLinkAudit.ranked;
    const researchUrls = new Set(researchLinks.map((link) => link.url));
    const rejectedLinks = officialLinks.filter((link) => !researchUrls.has(link.url));
    const nonResearchDestinations = rejectedLinks.filter((link) => researchLinkRejectionReason(link) === 'non_research_destination').length;
    const noResearchSignal = rejectedLinks.length - nonResearchDestinations;
    const researchPageLimit = options.maxResearchPagesPerProfile ?? MAX_LINKED_RESEARCH_PAGES_PER_PROFILE;
    if (!Number.isInteger(researchPageLimit) || researchPageLimit < 0 || researchPageLimit > MAX_LINKED_RESEARCH_PAGES_PER_PROFILE) {
      throw new Error(`maxResearchPagesPerProfile must be between 0 and ${MAX_LINKED_RESEARCH_PAGES_PER_PROFILE}`);
    }
    const selectedResearchLinks = researchLinks.slice(0, researchPageLimit);
    traversal.linkedResearchPagesConsidered = officialLinks.length;
    traversal.linkedResearchPagesFound = researchLinks.length;
    traversal.linkedResearchPagesSelected = selectedResearchLinks.map(({ rank, selectionReasons }) => ({ rank, reasons: [...selectionReasons] }));
    traversal.researchPageLinkRejections = [
      ...(nonResearchDestinations ? [{ reason: 'non_research_destination' as const, count: nonResearchDestinations }] : []),
      ...(noResearchSignal ? [{ reason: 'no_research_signal' as const, count: noResearchSignal }] : []),
    ];
    reportTraversal();
    for (const link of selectedResearchLinks) {
      const linkedResearch = await loadPage(link.url);
      traversal.linkedResearchPagesFetched += 1;
      reportTraversal();
      const quote = extractResearchQuote(linkedResearch.html);
      if (quote) {
        researchPage = linkedResearch;
        researchQuote = quote;
        traversal.relevantOfficialResearchEvidenceEstablished = true;
        reportTraversal();
        break;
      }
    }
  }
  traversal.professorIdentityEstablished = Boolean(profileIdentity);
  traversal.relevantOfficialResearchEvidenceEstablished = Boolean(researchQuote);
  reportTraversal();

  const profileRetrievedAt = retrievedAt();
  const excerpt = extractOfficialPageExcerpt(page.html);
  if (profileIdentity && researchQuote) {
    candidate.name = pageHeading(page.html) || profileIdentity.name;
    candidate.professorName = profileIdentity.name;
    candidate.leadType = 'professor_profile';
    candidate.officialProfileUrl = page.url;
    const email = options.collectContactEmail === false ? undefined : explicitlyAssociatedEmail(page.html, profileIdentity.name);
    if (email) {
      candidate.officialEmail = email;
      candidate.emailSourceUrl = page.url;
      evidence.push({ kind: 'contact', sourceUrl: page.url, excerpt, retrievedAt: profileRetrievedAt, verification: 'unverified', region: candidate.searchRegion ?? '', query: 'Official page explicitly associates this contact with the named profile' });
    }
    if (directoryPage.url !== page.url) evidence.push({ kind: 'official-page', sourceUrl: directoryPage.url, excerpt: directoryExcerpt, retrievedAt: profileRetrievedAt, verification: 'unverified', region: candidate.searchRegion ?? '', query: 'Official faculty directory linked to the individually named profile' });
    evidence.push({ kind: 'professor-profile', sourceUrl: page.url, excerpt, quote: page.url === researchPage.url ? researchQuote : profileIdentity.identityQuote, retrievedAt: profileRetrievedAt, verification: 'unverified', region: candidate.searchRegion ?? '', query: 'Official individual profile identifies this person; research may be established by a linked official page' });
    if (researchPage.url !== page.url) {
      evidence.push({ kind: 'research', sourceUrl: researchPage.url, excerpt: extractOfficialPageExcerpt(researchPage.html), quote: researchQuote, retrievedAt: retrievedAt(), verification: 'unverified', region: candidate.searchRegion ?? '', query: `Official research page linked from ${page.url}` });
    }
  } else {
    options.onProfessorEvidenceFailure?.(profileIdentity ? 'no_official_research_evidence' : 'no_named_professor_identity');
    candidate.name = pageHeading(directoryPage.html) || candidate.name;
    candidate.leadType = generalPageType(candidate.name, directoryPage.url);
    evidence.push({ kind: 'official-page', sourceUrl: directoryPage.url, excerpt: directoryExcerpt, retrievedAt: profileRetrievedAt, verification: 'unverified', region: candidate.searchRegion ?? '', query: 'Fetched from exact allowlisted official result URL; page type remains unreviewed' });
  }
  if (options.followSupplementaryLinks !== false) {
    const chosen = new Map<'program' | 'contact', string>();
    for (const link of linksFromHtml(page.html, page.url, hosts)) {
      const kind = linkKind(link);
      if ((kind === 'program' || kind === 'contact') && !chosen.has(kind)) chosen.set(kind, link.url);
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
  const hasSubstantiveResearch = evidence.some((item) =>
    (item.kind === 'professor-profile' || item.kind === 'research' || canonicalizeSourceUrl(item.sourceUrl) === profileUrl) &&
    item.excerpt.split(/(?<=[.!?])\s+/).some((sentence) =>
      sentence.length >= 50 && RESEARCH_SENTENCE.test(sentence) && (!item.quote || item.excerpt.includes(item.quote)),
    ),
  );
  if (!profileEvidence || !confirmedNamePattern.test(profileEvidence.excerpt) ||
      !confirmedNamePattern.test(candidate.name) || !hasSubstantiveResearch) {
    throw new Error('The selected official profile must identify the confirmed professor and reviewed evidence must support substantive research');
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
}): Promise<{ searches: number; saved: number; rejected: number; duplicates: number; validationRejections: number; officialPageFetchFailures: number; rejectedByCheck: { exactHost: number; title: number; excerpt: number }; poolSize: number; targetReached: boolean; skippedCountries: string[] }> {
  const targetPoolSize = input.options.targetPoolSize ?? 200;
  if (!Number.isInteger(targetPoolSize) || targetPoolSize < 1 || targetPoolSize > 200) {
    throw new Error('targetPoolSize must be an integer from 1 to 200');
  }
  const existingCandidates = await input.repository.list();
  const knownIds = new Set(existingCandidates.map((candidate) => candidate.id));
  const knownUrls = new Set(existingCandidates.flatMap((candidate) => (candidate.discoveryEvidence ?? [])
    .filter((item) => item.kind === 'search-result')
    .map((item) => canonicalizeSourceUrl(item.sourceUrl))));
  const knownOfficialProfileUrls = new Set([
    ...existingCandidates.flatMap((candidate) => candidate.officialProfileUrl ? [canonicalizeSourceUrl(candidate.officialProfileUrl)] : []),
    ...(input.options.additionalKnownOfficialProfileUrls ?? []).map(canonicalizeSourceUrl),
  ]);
  let poolSize = knownIds.size;
  const regions = [...new Set(input.profile.applicant.target.countries.map((country) => country.trim()).filter(Boolean))];
  if (regions.length === 0) throw new Error('At least one configured target country is required for discovery');
  const skippedCountries = regions.filter((region) => !input.options.officialHostsByRegion[region]?.length);
  const eligibleRegions = regions.filter((region) => input.options.officialHostsByRegion[region]?.length);
  if (poolSize >= targetPoolSize) {
    return { searches: 0, saved: 0, rejected: 0, duplicates: 0, validationRejections: 0, officialPageFetchFailures: 0, rejectedByCheck: { exactHost: 0, title: 0, excerpt: 0 }, poolSize, targetReached: true, skippedCountries };
  }
  if (eligibleRegions.length === 0) {
    return { searches: 0, saved: 0, rejected: 0, duplicates: 0, validationRejections: 0, officialPageFetchFailures: 0, rejectedByCheck: { exactHost: 0, title: 0, excerpt: 0 }, poolSize, targetReached: false, skippedCountries };
  }
  const interests = [...new Set([...input.profile.applicant.target.fields, ...input.profile.applicant.target.researchInterests]
    .map((item) => item.trim()).filter(Boolean))];
  if (interests.length === 0) throw new Error('At least one configured academic field or research interest is required');
  const queryInterests = input.options.oneQueryPerRegion ? [interests.join(' OR ')] : interests;

  let searches = 0;
  let saved = 0;
  let rejected = 0;
  let duplicates = 0;
  let validationRejections = 0;
  let officialPageFetchFailures = 0;
  const maxPageFetches = input.options.maxPageFetchesPerRun ?? MAX_OFFICIAL_PAGE_FETCHES_PER_RUN;
  if (!Number.isInteger(maxPageFetches) || maxPageFetches < 1) throw new Error('maxPageFetchesPerRun must be a positive integer');
  const pageFetchBudget = { remaining: maxPageFetches };
  const rejectedByCheck = { exactHost: 0, title: 0, excerpt: 0 };
  const seenUrls = new Set<string>(knownUrls);
  const maxSearches = input.options.maxSearches ?? Number.POSITIVE_INFINITY;
  if (!(maxSearches === Number.POSITIVE_INFINITY || Number.isInteger(maxSearches) && maxSearches > 0)) throw new Error('maxSearches must be a positive integer');
  const maxPagesPerQuery = input.options.maxPagesPerQuery ?? 1;
  if (!Number.isInteger(maxPagesPerQuery) || maxPagesPerQuery < 1 || maxPagesPerQuery > 10) throw new Error('maxPagesPerQuery must be from one through ten');
  const queryTypes = input.options.searchQueryTypes ?? ['general'];
  discovery: for (const region of eligibleRegions) {
    const configuredHosts = input.options.officialHostsByRegion[region];
    if (!configuredHosts?.length) continue;
    const hosts = [...new Set(configuredHosts.map(normalizeHost))];
    const hostGroups = input.options.oneSearchPerRegion ? [hosts] : hosts.map((host) => [host]);
    for (const matchingHosts of hostGroups) {
      for (const interest of queryInterests) {
        for (const queryType of queryTypes) {
        const query = queryFor(region, interest, matchingHosts, queryType);
        const recordRejection = async (checks: RejectedSearchResultChecks, resultNumber?: number) => {
          rejected += 1;
          validationRejections += 1;
          if (checks.exactHost) rejectedByCheck.exactHost += 1;
          if (checks.title) rejectedByCheck.title += 1;
          if (checks.excerpt) rejectedByCheck.excerpt += 1;
          await input.options.onRejectedResult?.(checks);
          await input.options.onResultDiagnostic?.({
            ...(resultNumber ? { resultNumber } : {}),
            stage: 'result_validation',
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
        const configuredCountryCode = input.options.countryCodesByRegion?.[region];
        const useApiCountry = isVerifiedBraveCountryCode(configuredCountryCode);
        const targetingMode = useApiCountry ? 'api_country' as const : 'query_and_host' as const;
        const resultLimit = input.options.resultsPerQuery ?? 10;
        let offset = 0;
        let moreResultsAvailable = true;
        let pagesFetched = 0;
        while (moreResultsAvailable && pagesFetched < maxPagesPerQuery) {
        if (searches >= maxSearches) {
          input.options.onCoverageStop?.('search_request_budget_exhausted');
          break discovery;
        }
        await input.options.onSearchTargeting?.({ country: region, mode: targetingMode });
        const searchOptions = {
          region,
          targetingMode,
          ...(useApiCountry ? { countryCode: configuredCountryCode.toUpperCase() } : {}),
          count: resultLimit,
          offset,
          ...(input.options.onRejectedResult || input.options.onResultDiagnostic ? { onRejectedResult: recordRejection } : {}),
        };
        searches += 1;
        const page = input.provider.searchPage
          ? await input.provider.searchPage(query, searchOptions)
          : { results: await input.provider.search(query, searchOptions), moreResultsAvailable: false, paginationKnown: true };
        const results = page.results;
        pagesFetched += 1;
        moreResultsAvailable = page.moreResultsAvailable;
        const retrievedAt = (input.options.now?.() ?? new Date()).toISOString();
        for (const [resultIndex, result] of results.entries()) {
          const resultNumber = result.resultNumber ?? resultIndex + 1;
          const emitPreview = async (
            reasonCode: CandidatePreviewReason,
            candidate?: ProfessorCandidate,
            identity?: { name: string; officialProfileUrl: string },
            traversal?: ProfessorTraversalDiagnostics,
          ) => {
            const profileUrl = candidate?.officialProfileUrl ?? identity?.officialProfileUrl;
            let research = (candidate?.discoveryEvidence ?? []).filter((item) =>
              item.kind === 'research' && item.quote?.trim(),
            );
            if (!research.length && traversal?.relevantOfficialResearchEvidenceEstablished) {
              research = (candidate?.discoveryEvidence ?? []).filter((item) =>
                item.kind === 'professor-profile' && item.sourceUrl === profileUrl && item.quote?.trim(),
              );
            }
            await input.options.onCandidatePreview?.({
              resultNumber,
              name: identity?.name ?? candidate?.professorName ?? candidate?.name ?? result.title,
              identityVerified: Boolean(identity || candidate?.professorName),
              outcome: reasonCode === 'passed_all_gates' ? 'passed' : 'stopped',
              reasonCode,
              ...(profileUrl ? { officialProfileSource: profileUrl } : {}),
              supportingResearch: research.slice(0, 5).flatMap((item) => item.quote?.trim()
                ? [{ sourceUrl: item.sourceUrl, quote: item.quote.slice(0, 360) }]
                : []),
            });
          };
          const failedChecks = {
            exactHost: !isAllowedOfficialUrl(result.url, matchingHosts),
            title: !result.title.trim(),
            excerpt: !result.excerpt.trim(),
            hostname: diagnosticResultHostname(result.url),
          };
          if (failedChecks.exactHost || failedChecks.title || failedChecks.excerpt) {
            await recordRejection(failedChecks, resultNumber);
            await emitPreview('invalid_search_result');
            continue;
          }
          const canonicalUrl = canonicalizeSourceUrl(result.url);
          if (seenUrls.has(canonicalUrl)) {
            duplicates += 1;
            await input.options.onResultDiagnostic?.({ resultNumber, stage: 'duplicate_check', country: region, hostname: failedChecks.hostname, outcome: 'duplicate', rejectionReasons: [] });
            await emitPreview('duplicate_saved_lead');
            continue;
          }
          seenUrls.add(canonicalUrl);
          const candidate = candidateFor(result, canonicalUrl, region, query, retrievedAt);
          if (knownIds.has(candidate.id)) {
            duplicates += 1;
            await input.options.onResultDiagnostic?.({ resultNumber, stage: 'duplicate_check', country: region, hostname: failedChecks.hostname, outcome: 'duplicate', rejectionReasons: [] });
            await emitPreview('duplicate_saved_lead', candidate);
            continue;
          }
          let professorEvidenceFailure: 'no_named_professor_identity' | 'no_official_research_evidence' | undefined;
          let professorTraversalDiagnostic: ProfessorTraversalDiagnostics | undefined;
          let verifiedIdentity: { name: string; officialProfileUrl: string } | undefined;
          try {
            await enrichOfficialCandidate(candidate, matchingHosts, {
              ...input.options,
              pageFetchBudget,
              onProfessorEvidenceFailure: (reason) => { professorEvidenceFailure = reason; },
              onProfessorIdentity: (identity) => { verifiedIdentity = identity; },
              onProfessorTraversalDiagnostic: (diagnostic) => { professorTraversalDiagnostic = diagnostic; },
            });
          } catch (error) {
            if (error instanceof DiscoveryPageFetchBudgetReached) {
              input.options.onCoverageStop?.('page_inspection_budget_exhausted');
              await emitPreview('page_fetch_limit', candidate, verifiedIdentity, professorTraversalDiagnostic);
              break discovery;
            }
            // A bad or unavailable official page rejects this lead, but should not discard later results.
            if (error instanceof SanitizedIntegrationError) {
              officialPageFetchFailures += 1;
              await input.options.onResultDiagnostic?.({
                resultNumber,
                stage: 'official_page_fetch',
                country: region,
                hostname: error.failure.resourceHost ?? failedChecks.hostname,
                outcome: 'fetch_failed',
                rejectionReasons: [error.failure.kind],
                ...(professorTraversalDiagnostic ?? {}),
                ...(error.failure.resourcePath ? { resourcePath: error.failure.resourcePath } : {}),
                ...(error.failure.statusCode ? { statusCode: error.failure.statusCode } : {}),
                ...(error.failure.errorName ? { errorName: error.failure.errorName } : {}),
                ...(error.failure.errorCode ? { errorCode: error.failure.errorCode } : {}),
                ...(error.failure.causeName ? { causeName: error.failure.causeName } : {}),
                ...(error.failure.causeCode ? { causeCode: error.failure.causeCode } : {}),
                ...(error.failure.braveErrorCode ? { braveErrorCode: error.failure.braveErrorCode } : {}),
                ...(error.failure.braveErrorId ? { braveErrorId: error.failure.braveErrorId } : {}),
                ...(error.failure.requestId ? { requestId: error.failure.requestId } : {}),
                ...(error.failure.redirectDestinationHost ? { redirectDestinationHost: error.failure.redirectDestinationHost } : {}),
                ...(error.failure.redirectDestinationPath ? { redirectDestinationPath: error.failure.redirectDestinationPath } : {}),
              });
              await emitPreview('official_page_fetch_failed', candidate, verifiedIdentity, professorTraversalDiagnostic);
              continue;
            }
            throw error;
          }
          const canonicalProfileUrl = candidate.officialProfileUrl ? canonicalizeSourceUrl(candidate.officialProfileUrl) : undefined;
          if (canonicalProfileUrl && knownOfficialProfileUrls.has(canonicalProfileUrl)) {
            duplicates += 1;
            await input.options.onResultDiagnostic?.({ resultNumber, stage: 'duplicate_check', country: region, hostname: failedChecks.hostname, outcome: 'duplicate', rejectionReasons: [] });
            await emitPreview('duplicate_official_profile', candidate, verifiedIdentity, professorTraversalDiagnostic);
            continue;
          }
          if (canonicalProfileUrl) knownOfficialProfileUrls.add(canonicalProfileUrl);
          const professorEvidence = candidate.discoveryEvidence?.find((item) =>
            item.kind === 'professor-profile' && item.sourceUrl === candidate.officialProfileUrl &&
            item.verification === 'unverified' && Boolean(item.quote?.trim()),
          );
          const researchEvidence = candidate.discoveryEvidence?.some((item) =>
            (item.kind === 'research' || item.kind === 'professor-profile') && item.verification === 'unverified' &&
            Boolean(item.quote?.trim()) && item.excerpt.includes(item.quote!),
          );
          if (input.options.saveOnlyProfessorProfiles &&
              (candidate.leadType !== 'professor_profile' || !candidate.officialProfileUrl || !professorEvidence || !researchEvidence)) {
            rejected += 1;
            validationRejections += 1;
            const rejectionReason = professorEvidenceFailure ?? (
              !candidate.professorName || !candidate.officialProfileUrl || !professorEvidence
                ? 'no_named_professor_identity'
                : 'no_official_research_evidence'
            );
            await input.options.onResultDiagnostic?.({
              resultNumber,
              stage: 'professor_evidence',
              country: region,
              hostname: failedChecks.hostname,
              outcome: 'rejected',
              rejectionReasons: [rejectionReason],
              ...(professorTraversalDiagnostic ?? {}),
            });
            const reasonCode = rejectionReason === 'no_official_research_evidence'
              ? 'research_evidence_missing'
              : 'identity_not_established';
            await emitPreview(reasonCode, candidate, verifiedIdentity, professorTraversalDiagnostic);
            continue;
          }
          if (input.options.shouldSaveCandidate && !input.options.shouldSaveCandidate(candidate)) {
            rejected += 1;
            validationRejections += 1;
            await input.options.onResultDiagnostic?.({
              resultNumber,
              stage: 'interest_match',
              country: region,
              hostname: failedChecks.hostname,
              outcome: 'rejected',
              rejectionReasons: ['research_interest_mismatch'],
              ...(professorTraversalDiagnostic ?? {}),
            });
            await emitPreview('research_interest_mismatch', candidate, verifiedIdentity, professorTraversalDiagnostic);
            continue;
          }
          await input.options.onResultDiagnostic?.({ resultNumber, stage: 'result_validation', country: region, hostname: failedChecks.hostname, outcome: 'page_validated', rejectionReasons: [], ...(professorTraversalDiagnostic ?? {}) });
          await emitPreview('passed_all_gates', candidate, verifiedIdentity, professorTraversalDiagnostic);
          await input.repository.save(candidate);
          knownIds.add(candidate.id);
          poolSize += 1;
          saved += 1;
          if (poolSize >= targetPoolSize) break discovery;
        }
        if (!page.paginationKnown) {
          input.options.onCoverageStop?.('pagination_metadata_unavailable');
          moreResultsAvailable = false;
        }
        if (moreResultsAvailable && pagesFetched >= maxPagesPerQuery) {
          input.options.onCoverageStop?.('pagination_budget_exhausted');
          break;
        }
        offset += 1;
        }
        }
      }
    }
  }
  return { searches, saved, rejected, duplicates, validationRejections, officialPageFetchFailures, rejectedByCheck, poolSize, targetReached: poolSize >= targetPoolSize, skippedCountries };
}
