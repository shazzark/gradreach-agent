import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GradReach | Private research desk',
  description: 'Private owner workspace for evidence-led graduate research and reviewed outreach.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
