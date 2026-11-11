'use client';

import { ui } from '../../../src/web/ui-classes.ts';

export default function ConfirmedProfessorsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="min-w-0"><div className={ui.pageHead}><div><p className={ui.eyebrow}>Private discovery library</p><h1 className={ui.pageTitle}>Confirmed professors unavailable</h1><p className={ui.pageDescription}>The saved local previews could not be loaded.</p></div></div><section className={ui.panel}><p className={ui.warning} role="alert">No professor records were changed. Check local preview availability and try again.</p><button className={ui.primaryButton} type="button" onClick={() => reset()}>Try again</button></section></main>;
}
