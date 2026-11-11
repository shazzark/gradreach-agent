import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'GradReach · Research workspace',
    short_name: 'GradReach',
    description: 'Evidence-led graduate research in a private owner workspace.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f3f4ee',
    theme_color: '#176c55',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
  };
}
