import Link from 'next/link';
import { requireOwner } from '../../src/web/owner-data.ts';
import { signOutAction } from '../actions.ts';

export const dynamic = 'force-dynamic';

export default async function OwnerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await requireOwner();
  return <div className="shell">
    <header className="masthead"><Link className="brand" href="/">GradReach <span className="brand-mark">/</span> Research desk</Link><span className="private-label">PRIVATE · OWNER ACCESS</span></header>
    <nav className="nav" aria-label="Owner workspace">
      <Link href="/">Overview</Link><Link href="/leads">Leads &amp; evidence</Link><Link href="/programs">Programs</Link><Link href="/profile">Profile settings</Link><Link href="/drafts">Draft review</Link><Link href="/outreach">Outreach queue</Link>
      <form action={signOutAction}><button className="secondary" type="submit">Sign out</button></form>
    </nav>
    {children}
    <footer className="footer">Private owner workspace · Source evidence remains review gated · Website sign-in does not connect Gmail or authorize sending.</footer>
  </div>;
}
