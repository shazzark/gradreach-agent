import { requireOwner } from '../../src/web/owner-data.ts';
import { WorkspaceNavigation } from '../../src/web/workspace-navigation-client.tsx';
import { JobProgressClient } from '../../src/web/job-progress-client.tsx';

export const dynamic = 'force-dynamic';

export default async function OwnerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireOwner();
  return <div className="min-h-screen bg-paper">
    <WorkspaceNavigation/>
    <JobProgressClient/>
    <div className="mx-auto min-h-screen w-full min-w-0 max-w-[1600px] px-4 pb-8 sm:px-6 lg:ml-[232px] lg:w-[calc(100%-232px)] lg:px-8 xl:px-12">
      {children}
      <footer className="mt-12 border-t border-line py-6 text-xs leading-5 text-muted">Private owner workspace · Source evidence remains review gated · Website sign-in does not connect Gmail or authorize sending.</footer>
    </div>
  </div>;
}
