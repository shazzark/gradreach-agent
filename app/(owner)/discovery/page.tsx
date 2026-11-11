import type { Metadata } from 'next';
import { saveDiscoveryScheduleAction, toggleDiscoveryPauseAction } from '../../actions.ts';
import { withOwnerData } from '../../../src/web/owner-data.ts';
import { getAutomaticDiscoverySettings } from '../../../src/web/owner-workflows.ts';
import { DISCOVERY_LIMITS } from '../../../src/application/automatic-discovery.ts';
import { ui } from '../../../src/web/ui-classes.ts';

export const metadata: Metadata = { title: { absolute: 'GradReach | Discovery schedule' } };

export default async function DiscoveryPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const [{ schedule, verifiedCountries, runs, checks }, query] = await Promise.all([
    withOwnerData(getAutomaticDiscoverySettings), searchParams,
  ]);
  return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Phase 9 · Automatic research</p><h1 className={ui.pageTitle}>Discovery schedule</h1><p className={ui.pageDescription}>Choose when to inspect official pages and search one evidence-backed country. Automatic research is off until you enable it here.</p></div><span className={ui.status}>{schedule.enabled && !schedule.paused ? 'Enabled' : 'Disabled / paused'}</span></div>
    {query.state === 'unavailable' ? <p className={ui.warning} role="status">The discovery settings could not be updated. No discovery job was started.</p> : query.state === 'saved' ? <p className={ui.note} role="status">Discovery settings updated. A worker still requires its separate deployment opt-in.</p> : null}
    <section className={`${ui.grid} ${ui.section}`}>
      <article className={`${ui.panel} xl:col-span-2`}>
        <p className={ui.eyebrow}>Schedule controls</p><h2 className="mb-4 mt-2 font-display text-xl font-bold">Configure automatic research</h2>
        <form action={saveDiscoveryScheduleAction} className={ui.formGrid}>
          <label className={ui.formLabel}>Frequency<select className={ui.input} name="frequency" defaultValue={schedule.frequency}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
          <label className={ui.formLabel}>Day (weekly)<select className={ui.input} name="dayOfWeek" defaultValue={schedule.dayOfWeek}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label>
          <label className={ui.formLabel}>Local time<input className={ui.input} type="time" name="time" defaultValue={schedule.time} required/></label>
          <label className={ui.formLabel}>Timezone<input className={ui.input} name="timeZone" defaultValue={schedule.timeZone || 'Africa/Lagos'} required/><span className="text-xs font-normal text-muted">Use an IANA timezone, for example Africa/Lagos.</span></label>
          <fieldset className={`${ui.fieldset} md:col-span-2`}><legend className="px-1 text-sm font-semibold">Countries with verified official hosts</legend><div className="grid min-w-0 grid-cols-1 gap-x-5 sm:grid-cols-2 xl:grid-cols-3">{verifiedCountries.map((country) => <label key={country} className={ui.checkRow}><input type="checkbox" name="countries" value={country} defaultChecked={schedule.countries.includes(country)}/><span className="break-words">{country}</span></label>)}</div>{verifiedCountries.length === 0 ? <p className={ui.muted}>No configured countries have a verified official host yet.</p> : null}</fieldset>
          <label className="flex items-center gap-2 text-sm font-semibold md:col-span-2"><input type="checkbox" name="enabled" defaultChecked={schedule.enabled}/> Enable scheduled discovery</label>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2"><button className={ui.primaryButton} type="submit">Save schedule</button><span className="text-xs text-muted">Each due run: at most {DISCOVERY_LIMITS.searchesPerRun} search × {DISCOVERY_LIMITS.resultsPerSearch} results and {DISCOVERY_LIMITS.inspectionsPerRun} read-only inspections.</span></div>
        </form>
        <form action={toggleDiscoveryPauseAction} className="mt-4 border-t border-line pt-4"><button className={schedule.paused ? ui.secondaryButton : ui.dangerButton} type="submit">{schedule.paused ? 'Unpause automatic research' : 'Pause automatic research'}</button></form>
      </article>
      <article className={ui.panel}><p className={ui.eyebrow}>Human decisions stay human</p><h2 className="mb-2 mt-2 font-display text-xl font-bold">Evidence only</h2><p className="text-sm leading-6 text-muted">Automatic checks add separate dated inspection records. They never accept or reject a professor, approve outreach, or send email. MongoDB remains authoritative for saved leads.</p></article>
    </section>
    <section className={ui.section}><h2 className={ui.sectionTitle}>Recent runs</h2>{runs.length ? <div className={ui.list}>{runs.map((run) => <article className={ui.panel} key={run.id}><div className={ui.cardTopline}><strong>{run.country ?? 'No country selected'}</strong><span className={ui.status}>{run.state}</span></div><p className="mb-0 mt-2 break-words text-sm text-muted">{run.startedAt} · {run.counts.searches} searches, {run.counts.saved} saved, {run.counts.duplicates} duplicates, {run.counts.rejections} rejected, {run.counts.inspected} pages inspected{run.targetingMode ? ` · ${run.targetingMode === 'api_country' ? 'Brave country targeting' : 'Query and official-host targeting'}` : ''}{run.failureCode ? ` · ${run.failureCode}` : ''}</p></article>)}</div> : <p className={ui.panel}>No automatic discovery runs recorded.</p>}</section>
    <section className={ui.section}><h2 className={ui.sectionTitle}>Recent page checks</h2>{checks.length ? <div className={ui.list}>{checks.map((check) => <article className={ui.panel} key={check.id}><div className={ui.cardTopline}><strong>{check.outcome === 'checked' ? 'Page checked' : 'Check failed'}</strong><span className={ui.status}>{check.checkedAt}</span></div><a className="mt-2 block break-all text-sm text-green underline" href={check.sourceUrl} target="_blank" rel="noreferrer">{check.sourceUrl}</a>{check.excerpt ? <p className="mb-0 mt-3 break-words text-sm text-muted">{check.excerpt}</p> : null}{check.failureCode ? <p className="mb-0 mt-2 text-sm text-muted">Safe status: {check.failureCode}</p> : null}</article>)}</div> : <p className={ui.panel}>No official page checks recorded.</p>}</section>
  </main>;
}
