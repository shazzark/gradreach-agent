'use client';

import { ui } from '../../src/web/ui-classes.ts';

export default function WorkspaceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="min-w-0">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Workspace unavailable</p><h1 className={ui.pageTitle}>Saved data could not be loaded</h1><p className={ui.pageDescription}>Your records were not changed. Check the connection and try loading this page again.</p></div></div>
    <section className={ui.panel}><p className={ui.warning} role="alert">GradReach could not load this workspace request.</p><button className={ui.primaryButton} type="button" onClick={() => reset()}>Try again</button></section>
  </main>;
}
