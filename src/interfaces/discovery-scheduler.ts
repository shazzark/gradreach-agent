import '../infrastructure/local-env.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runAutomaticDiscovery } from '../application/automatic-discovery.ts';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { fetchOfficialPage } from '../application/research-discovery.ts';
import { BraveSearchProvider } from '../infrastructure/brave-search-provider.ts';
import { connectMongoStorage } from '../infrastructure/mongo-storage.ts';
import { publishJobProgress } from '../infrastructure/job-progress-bus.ts';

const POLL_INTERVAL_MS = 60_000;

export async function runDiscoveryScheduler(): Promise<void> {
  if (process.env.GRADREACH_DISCOVERY_SCHEDULER_ENABLED !== 'true') {
    process.stdout.write('Automatic discovery is disabled. Set GRADREACH_DISCOVERY_SCHEDULER_ENABLED=true after configuring the owner schedule and worker deployment.\n');
    return;
  }
  let stop = false;
  let wake!: () => void;
  const stopped = new Promise<void>((resolvePromise) => { wake = resolvePromise; });
  const stopScheduler = () => { stop = true; wake(); };
  process.once('SIGINT', stopScheduler);
  process.once('SIGTERM', stopScheduler);
  try {
    while (!stop) {
      let storage: Awaited<ReturnType<typeof connectMongoStorage>> | undefined;
      try {
        storage = await connectMongoStorage();
        const profile = await storage.repositories.profiles.get('primary');
        if (profile) {
          const hosts = Object.fromEntries(Object.entries(OFFICIAL_HOSTS_BY_REGION).map(([country, entries]) => [country, [...entries]]));
          const result = await runAutomaticDiscovery({
            repositories: {
              candidates: storage.repositories.candidates,
              profile: storage.repositories.profiles,
              schedule: storage.repositories.discoverySchedule,
              runs: storage.repositories.discoveryRuns,
              checks: storage.repositories.discoveryChecks,
              confirmedProfessors: storage.repositories.confirmedProfessors,
            },
            configuredCountries: profile.applicant.target.countries,
            verifiedCountries: Object.keys(OFFICIAL_HOSTS_BY_REGION),
            provider: new BraveSearchProvider(),
            officialHostsByRegion: hosts,
            countryCodesByRegion: COUNTRY_CODES,
            fetchPage: (url, allowed) => fetchOfficialPage(url, allowed),
            taskName: 'GradReach Discovery Worker',
            workerId: `GradReach Discovery Worker:${process.pid}`,
            onProgress: publishJobProgress,
          });
          if (result.state !== 'not_due' && result.state !== 'paused') process.stdout.write(`${JSON.stringify({ state: result.state, countries: 'countries' in result ? result.countries : undefined, country: 'country' in result ? result.country : undefined, targetingMode: 'targetingMode' in result ? result.targetingMode : undefined, countryOutcomes: 'countryOutcomes' in result ? result.countryOutcomes : undefined, counts: result.counts, failureCode: 'failureCode' in result ? result.failureCode : undefined })}\n`);
        }
      } catch {
        process.stderr.write('Automatic discovery worker cycle failed; check local configuration and MongoDB/provider availability.\n');
      } finally {
        try { await storage?.close(); } catch { /* Keep cycle diagnostics independent from shutdown errors. */ }
      }
      if (!stop) await Promise.race([new Promise<void>((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS)), stopped]);
    }
  } finally {
    process.removeListener('SIGINT', stopScheduler);
    process.removeListener('SIGTERM', stopScheduler);
  }
}

const COUNTRY_CODES: Record<string, string> = {
  Belgium: 'BE', Australia: 'AU', Canada: 'CA', China: 'CN', Italy: 'IT', Japan: 'JP', 'New Zealand': 'NZ',
  'South Korea': 'KR', Switzerland: 'CH', Portugal: 'PT', 'United States': 'US', 'Bosnia and Herzegovina': 'BA',
  Bulgaria: 'BG', Croatia: 'HR', Czechia: 'CZ', Denmark: 'DK', Estonia: 'EE', Finland: 'FI', France: 'FR', Germany: 'DE',
  Greece: 'GR', Hungary: 'HU', Iceland: 'IS', Ireland: 'IE', Latvia: 'LV', Liechtenstein: 'LI', Lithuania: 'LT',
  Luxembourg: 'LU', Malta: 'MT', Moldova: 'MD', Montenegro: 'ME', Netherlands: 'NL', Norway: 'NO', Poland: 'PL', Russia: 'RU',
  Serbia: 'RS', Slovakia: 'SK', Slovenia: 'SI', Spain: 'ES', Sweden: 'SE', Ukraine: 'UA', 'United Kingdom': 'GB',
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runDiscoveryScheduler().catch(() => {
    process.stderr.write('Could not start the discovery scheduler; check local configuration and MongoDB access.\n');
    process.exitCode = 1;
  });
}
