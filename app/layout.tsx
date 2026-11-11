import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'GradReach | Evidence-led graduate research', template: '%s | GradReach' },
  description: 'Evidence-led graduate research and carefully reviewed outreach in a private owner workspace.',
  robots: { index: false, follow: false },
  applicationName: 'GradReach',
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
