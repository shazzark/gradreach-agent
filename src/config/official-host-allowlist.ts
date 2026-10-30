// Exact official university hosts checked on university pages; see docs/phase-3-allowlist.md for evidence.
export const OFFICIAL_HOSTS_BY_REGION = {
  Canada: ['uwaterloo.ca'],
  Australia: ['www.sydney.edu.au'],
  China: ['ac.cs.tsinghua.edu.cn'],
  Japan: [
    'www.kyoto-u.ac.jp',
    'www.agent.soc.i.kyoto-u.ac.jp',
    'www.s-im.t.kyoto-u.ac.jp',
    'www.i.kyoto-u.ac.jp',
  ],
  'South Korea': ['cs.kaist.ac.kr'],
  'United States': ['siebelschool.illinois.edu'],
  'New Zealand': ['www.cs.auckland.ac.nz', 'cs.auckland.ac.nz'],
  Switzerland: ['inf.ethz.ch'],
  Portugal: ['tecnico.ulisboa.pt'],
  Italy: ['www.polimi.it'],
} as const;
