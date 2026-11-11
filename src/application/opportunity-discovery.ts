import { createHash } from 'node:crypto';
import type { ApplicantProfile } from '../domain/applicant-profile.ts';
import type { OfficialEvidence, ProgramRecord } from '../domain/program-assessment.ts';
import { parseProgramRecord } from '../domain/program-assessment.ts';
import { matchingResearchInterests } from '../domain/research-interest-match.ts';
import { opportunityKindForSource, officialOpportunitySources } from '../config/official-opportunity-hosts.ts';
import { fetchOfficialPage, extractOfficialPageExcerpt } from './research-discovery.ts';
import { safeFailureRecord } from '../infrastructure/sanitized-failure.ts';
import type { SearchProvider } from '../infrastructure/brave-search-provider.ts';
import { OPPORTUNITY_DISCOVERY_LIMITS, type OpportunityDiscoveryRun, type OpportunitySearchSource, type OpportunitySourceRun, type OpportunityStopReason } from '../domain/opportunity-discovery.ts';
import { OFFICIAL_INSTITUTION_BY_REGION } from '../config/official-host-allowlist.ts';

export interface OpportunityDiscoveryRepositories {
  opportunityDiscoveryRuns: {
    claim(run: OpportunityDiscoveryRun): Promise<boolean>;
    recordProgress(run: OpportunityDiscoveryRun): Promise<void>;
    recordSource(runId: string, source: OpportunitySourceRun): Promise<void>;
    finish(run: OpportunityDiscoveryRun): Promise<boolean>;
  };
  programs: {
    saveDiscovered(program: ProgramRecord): Promise<{ id: string; duplicate: boolean; reason?: 'source' | 'identity' }>;
  };
}

const SOURCE_TERMS: Record<OpportunitySearchSource, string> = {
  university: '(MSc OR "master of science" OR "master programme" OR "graduate program")',
  scholarship: '(scholarship OR funding OR "Erasmus Mundus" OR DAAD)',
  company: '("graduate program" OR "graduate programme" OR "early career" OR "recent graduate")',
};

const COUNTRY_ALIASES: Record<string, string[]> = {
  'Bosnia and Herzegovina': ['Bosnia and Herzegovina', 'Bosnia'],
  Czechia: ['Czechia', 'Czech Republic'],
  'South Korea': ['South Korea', 'Republic of Korea'],
  'United Kingdom': ['United Kingdom', 'UK'],
  'United States': ['United States', 'USA', 'U.S.'],
};

function exactHost(value: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function countryIsOnOfficialPage(excerpt: string, country: string): boolean {
  const candidates = COUNTRY_ALIASES[country] ?? [country];
  const text = excerpt.toLocaleLowerCase('en');
  return candidates.some((candidate) => text.includes(candidate.toLocaleLowerCase('en')));
}

function buildSearchQuery(source: OpportunitySearchSource, country: string, hosts: readonly string[], interests: string[]): string {
  const hostFilter = hosts.slice(0, 8).map((host) => `site:${host}`).join(' OR ');
  const interestFilter = interests.slice(0, 8).map((interest) => `"${interest.replace(/["\\]/g, '').slice(0, 72)}"`).join(' OR ');
  let query = `(${hostFilter}) ${SOURCE_TERMS[source]} "${country.slice(0, 80)}" (${interestFilter})`;
  while (query.length > 590 && interests.length > 1) {
    interests = interests.slice(0, -1);
    query = `(${hostFilter}) ${SOURCE_TERMS[source]} "${country.slice(0, 80)}" (${interests.slice(0, 8).map((interest) => `"${interest.replace(/["\\]/g, '').slice(0, 72)}"`).join(' OR ')})`;
  }
  if (!hostFilter || !interestFilter || query.length > 600) throw new Error('invalid_query_parameters');
  return query;
}

function pageTitle(html: string): string {
  const title = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1] ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const cleaned = title ? extractOfficialPageExcerpt(title, 200) : '';
  return cleaned;
}

function evidence(sourceUrl: string, checkedAt: string, excerpt: string): OfficialEvidence {
  return { sourceUrl, checkedAt, excerpt: excerpt.slice(0, 1200), uncertainty: '', verification: 'unreviewed' };
}

function canonicalSourceForId(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function sourceFacts(text: string): { funding?: string; compensation?: string; eligibility?: string; deadline?: { value: string; excerpt: string } } {
  const sentences = text.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
  const statesFact = (sentence: string) => !/\b(?:not\s+(?:stated|specified|available|provided|offered)|unknown|unspecified|no\s+(?:funding|scholarships?|stipends?|grants?|fee waivers?|salary|compensation)|does not state)\b/i.test(sentence);
  const funding = sentences.find((sentence) => statesFact(sentence) && /\b(scholarship|funding|stipend|grant|fee waiver)\b/i.test(sentence));
  const compensation = sentences.find((sentence) => statesFact(sentence) && /\b(salary|compensation|paid|pay range|hourly rate|base pay)\b/i.test(sentence));
  const eligibility = sentences.find((sentence) => /\b(eligib|must have|required qualification|applicants must|degree required)\b/i.test(sentence));
  const deadlineSentence = sentences.find((sentence) => /\b(deadline|apply by|applications? (?:close|due)|closing date)\b/i.test(sentence));
  const iso = deadlineSentence?.match(/\b20\d{2}-[01]\d-[0-3]\d\b/)?.[0];
  const named = deadlineSentence?.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b/i)?.[0];
  const deadlineDate = iso ?? (named && Number.isFinite(Date.parse(named)) ? new Date(named).toISOString().slice(0, 10) : undefined);
  return {
    ...(funding ? { funding: funding.slice(0, 400) } : {}),
    ...(compensation ? { compensation: compensation.slice(0, 400) } : {}),
    ...(eligibility ? { eligibility: eligibility.slice(0, 400) } : {}),
    ...(deadlineSentence && deadlineDate ? { deadline: { value: `${deadlineDate}T00:00:00.000Z`, excerpt: deadlineSentence.slice(0, 400) } } : {}),
  };
}

function createRecord(input: {
  html: string; sourceUrl: string; source: OpportunitySearchSource; organization: string;
  country: string; fields: string[]; checkedAt: string;
}): ProgramRecord | undefined {
  const excerpt = extractOfficialPageExcerpt(input.html, 1200);
  const title = pageTitle(input.html);
  if (!excerpt || !title) return undefined;
  const kind = opportunityKindForSource(input.source);
  const factEvidence = sourceFacts(excerpt);
  const rootEvidence = evidence(input.sourceUrl, input.checkedAt, excerpt);
  const program: Record<string, unknown> = {
    id: `opportunity-${createHash('sha256').update(`${kind}|${input.country}|${canonicalSourceForId(input.sourceUrl)}`).digest('hex').slice(0, 32)}`,
    kind,
    institution: input.source === 'university' ? (OFFICIAL_INSTITUTION_BY_REGION as Record<string, string>)[input.country] ?? input.organization : input.organization,
    name: title,
    country: input.country,
    intake: '',
    sourceEvidence: rootEvidence,
    lastCheckedAt: input.checkedAt,
  };
  const normalizedExcerpt = excerpt.toLocaleLowerCase('en');
  const statedField = input.fields.find((field) => field.trim() && normalizedExcerpt.includes(field.trim().toLocaleLowerCase('en')));
  if (statedField) program.field = statedField;
  const degree = title.match(/\b(MSc|M\.Sc\.|master(?:'s)?(?:\s+of\s+science)?)\b/i)?.[0];
  if (degree) program.degree = degree;
  if (factEvidence.funding) program.fundingDetails = { summary: factEvidence.funding, evidence: evidence(input.sourceUrl, input.checkedAt, factEvidence.funding) };
  if (input.source === 'company' && factEvidence.compensation) program.compensation = { summary: factEvidence.compensation, evidence: evidence(input.sourceUrl, input.checkedAt, factEvidence.compensation) };
  if (factEvidence.eligibility) program.eligibility = { summary: factEvidence.eligibility, evidence: evidence(input.sourceUrl, input.checkedAt, factEvidence.eligibility) };
  if (factEvidence.deadline) program.deadline = { date: factEvidence.deadline.value, evidence: evidence(input.sourceUrl, input.checkedAt, factEvidence.deadline.excerpt) };
  if (input.source !== 'university' && !countryIsOnOfficialPage(excerpt, input.country)) return undefined;
  return parseProgramRecord(program, { allowUnreviewedEvidence: true });
}

function zeroCounts(): OpportunityDiscoveryRun['counts'] {
  return { searches: 0, results: 0, pagesFetched: 0, interestMatches: 0, saved: 0, duplicates: 0, rejected: 0, failures: 0 };
}

function zeroSource(country: string, source: OpportunitySearchSource, hosts: readonly string[], state: OpportunitySourceRun['state'] = 'completed'): OpportunitySourceRun {
  return { country, source, hosts: [...hosts], state, counts: zeroCounts(), stopReasons: [] };
}

function reasonOnce(target: OpportunityStopReason[], reason: OpportunityStopReason): void {
  if (!target.includes(reason)) target.push(reason);
}

function safeFailureReason(error: unknown): OpportunityStopReason {
  const failure = safeFailureRecord(error);
  return failure.kind === 'missing_configuration' ? 'missing_configuration' : 'provider_failure';
}

/** Runs one owner-triggered, bounded sweep. Queries and provider response bodies never enter the run record. */
export async function runOpportunityDiscovery(input: {
  repositories: OpportunityDiscoveryRepositories;
  profile: ApplicantProfile | undefined;
  provider: SearchProvider;
  requestId: string;
  now?: () => Date;
  fetchPage?: (url: string, hosts: string[]) => Promise<{ url: string; html: string }>;
}): Promise<OpportunityDiscoveryRun> {
  if (!/^[A-Fa-f0-9-]{36}$/.test(input.requestId)) throw new Error('Invalid opportunity discovery request ID');
  const now = input.now ?? (() => new Date());
  const id = `opportunity_${createHash('sha256').update(input.requestId).digest('hex').slice(0, 36)}`;
  const startedAt = now().toISOString();
  const profile = input.profile;
  const countries = profile?.applicant.target.countries.slice(0, OPPORTUNITY_DISCOVERY_LIMITS.countriesPerRun) ?? [];
  const run: OpportunityDiscoveryRun = {
    system: 'opportunity', id, trigger: 'manual', startedAt, countries, state: 'running',
    counts: zeroCounts(), sources: [], stopReasons: [],
  };
  if (!(await input.repositories.opportunityDiscoveryRuns.claim(run))) return run;
  const persistCounts = async () => input.repositories.opportunityDiscoveryRuns.recordProgress(run);
  const persistSource = async (source: OpportunitySourceRun) => {
    const index = run.sources.findIndex((item) => item.country === source.country && item.source === source.source);
    if (index >= 0) run.sources[index] = source; else run.sources.push(source);
    await input.repositories.opportunityDiscoveryRuns.recordSource(run.id, source);
  };

  try {
    if (!profile) {
      reasonOnce(run.stopReasons, 'missing_configuration');
      run.state = 'failed';
    } else if (!countries.length) {
      reasonOnce(run.stopReasons, 'missing_configuration');
      run.state = 'failed';
    } else if (!profile.applicant.target.researchInterests.length) {
      reasonOnce(run.stopReasons, 'missing_research_interests');
      run.state = 'failed';
    } else {
      const interests = profile.applicant.target.researchInterests.map((item) => item.trim()).filter(Boolean);
      let pageBudget = OPPORTUNITY_DISCOVERY_LIMITS.pageFetchesPerRun;
      let hadFailure = false;
      for (const country of countries) {
        const sources = officialOpportunitySources(country);
        for (const definition of sources) {
          const source = zeroSource(country, definition.source, definition.hosts);
          if (source.source === 'university' && source.hosts.length === 0) {
            source.state = 'skipped';
            reasonOnce(source.stopReasons, 'no_verified_host');
            reasonOnce(run.stopReasons, 'no_verified_host');
            await persistSource(source);
            continue;
          }
          try {
            const query = buildSearchQuery(source.source, country, source.hosts, interests);
            source.counts.searches = 1;
            run.counts.searches += 1;
            const page = input.provider.searchPage
              ? await input.provider.searchPage(query, { count: OPPORTUNITY_DISCOVERY_LIMITS.resultsPerSearch })
              : { results: await input.provider.search(query, { count: OPPORTUNITY_DISCOVERY_LIMITS.resultsPerSearch }), moreResultsAvailable: false, paginationKnown: false };
            source.counts.results = page.results.length;
            run.counts.results += page.results.length;
            if (!page.results.length) reasonOnce(source.stopReasons, 'no_results');
            for (const result of page.results.slice(0, OPPORTUNITY_DISCOVERY_LIMITS.resultsPerSearch)) {
              if (!exactHost(result.url, source.hosts)) {
                source.counts.rejected++; run.counts.rejected++;
                reasonOnce(source.stopReasons, 'unverified_result_host');
                continue;
              }
              if (pageBudget <= 0) {
                source.counts.rejected++; run.counts.rejected++;
                reasonOnce(source.stopReasons, 'page_fetch_budget');
                continue;
              }
              pageBudget--;
              let fetched: { url: string; html: string };
              try {
                fetched = await (input.fetchPage ?? ((url, hosts) => fetchOfficialPage(url, hosts)))(result.url, [...source.hosts]);
              } catch {
                source.counts.failures++; run.counts.failures++;
                reasonOnce(source.stopReasons, 'page_fetch_failed');
                hadFailure = true;
                continue;
              }
              source.counts.pagesFetched++; run.counts.pagesFetched++;
              if (!exactHost(fetched.url, source.hosts)) {
                source.counts.rejected++; run.counts.rejected++;
                reasonOnce(source.stopReasons, 'unverified_result_host');
                continue;
              }
              const checkedAt = now().toISOString();
              const excerpt = extractOfficialPageExcerpt(fetched.html, 1200);
              if (!matchingResearchInterests(excerpt, interests).length) {
                source.counts.rejected++; run.counts.rejected++;
                reasonOnce(source.stopReasons, 'no_interest_match');
                continue;
              }
              if (source.source !== 'university' && !countryIsOnOfficialPage(excerpt, country)) {
                source.counts.rejected++; run.counts.rejected++;
                reasonOnce(source.stopReasons, 'country_not_confirmed');
                continue;
              }
              source.counts.interestMatches++; run.counts.interestMatches++;
              let record: ProgramRecord | undefined;
              try {
            const fetchedHost = new URL(fetched.url).hostname.toLowerCase();
              const organization = fetchedHost === 'www2.daad.de' ? 'DAAD'
                : definition.hosts.includes('erasmus-plus.ec.europa.eu') && source.source === 'scholarship' ? 'Erasmus+' : definition.organization;
              record = createRecord({ html: fetched.html, sourceUrl: fetched.url, source: source.source, organization, country, fields: profile.applicant.target.fields, checkedAt });
              } catch { /* Malformed source details stop at the record validator. */ }
              if (!record) {
                source.counts.rejected++; run.counts.rejected++;
                reasonOnce(source.stopReasons, 'invalid_official_record');
                continue;
              }
              const saved = await input.repositories.programs.saveDiscovered(record);
              if (saved.duplicate) {
                source.counts.duplicates++; run.counts.duplicates++;
                reasonOnce(source.stopReasons, saved.reason === 'source' ? 'duplicate_source' : 'duplicate_identity');
              } else {
                source.counts.saved++; run.counts.saved++;
                reasonOnce(source.stopReasons, 'saved');
              }
              await persistCounts();
            }
          } catch (error) {
            source.state = 'failed';
            source.counts.failures++; run.counts.failures++;
            const reason = safeFailureReason(error);
            reasonOnce(source.stopReasons, reason);
            reasonOnce(run.stopReasons, reason);
            hadFailure = true;
          }
          if (source.counts.failures) source.state = 'failed';
          await persistSource(source);
          await persistCounts();
        }
      }
      run.state = hadFailure ? (run.sources.some((source) => source.state === 'completed') ? 'partial' : 'failed') : 'completed';
    }
  } catch {
    run.state = 'failed';
    reasonOnce(run.stopReasons, 'provider_failure');
    run.counts.failures++;
  }
  run.completedAt = now().toISOString();
  await input.repositories.opportunityDiscoveryRuns.finish(run);
  return run;
}
