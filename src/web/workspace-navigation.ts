export const workspaceNavigation = [
  { href: '/workspace', label: 'Overview' },
  { href: '/leads', label: 'Leads & evidence' },
  { href: '/confirmed-professors', label: 'Confirmed professors' },
  { href: '/programs', label: 'Programs' },
  { href: '/profile', label: 'Profile settings' },
  { href: '/drafts', label: 'Draft review' },
  { href: '/outreach', label: 'Outreach queue' },
  { href: '/discovery', label: 'Discovery schedule' },
] as const;

export function isWorkspaceNavigationActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== '/workspace' && pathname.startsWith(`${href}/`));
}
