import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  // Private local reports and tokens must stay outside deployable server traces.
  outputFileTracingExcludes: { '/*': ['./private-data/**/*'] },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Cache-Control', value: 'no-store, max-age=0' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
      ],
    }];
  },
};

export default config;
