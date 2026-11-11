import { ui } from '../../../src/web/ui-classes.ts';

export default function ConfirmedProfessorsLoading() {
  return <main className="min-w-0" aria-live="polite" aria-busy="true">
    <div className={ui.pageHead}><div><p className={ui.eyebrow}>Private discovery library</p><h1 className={ui.pageTitle}>Loading confirmed professors</h1><p className={ui.pageDescription}>Reading saved local discovery previews.</p></div></div>
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">{[1, 2, 3].map((item) => <div key={item} className="h-64 animate-pulse rounded-2xl border border-line bg-white"/>)}</div>
  </main>;
}
