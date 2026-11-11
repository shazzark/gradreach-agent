import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', borderRadius: 38, background: '#176c55', color: '#f3f4ee', fontFamily: 'Arial, sans-serif', fontSize: 66, fontWeight: 700, letterSpacing: -6 }}>
      GR<span style={{ display: 'flex', width: 14, height: 14, marginLeft: 2, marginTop: -54, borderRadius: 99, background: '#db9c3a' }}/>
    </div>,
    size,
  );
}
