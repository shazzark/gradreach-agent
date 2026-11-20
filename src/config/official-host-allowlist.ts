// Exact official university hosts checked on university pages; see docs/phase-3-allowlist.md for evidence.
export const OFFICIAL_HOSTS_BY_REGION = {
  Belgium: ['eng.kuleuven.be'],
  Canada: [
    'uwaterloo.ca',
    'www.cs.toronto.edu',
    'www.cs.ubc.ca',
    'www.cs.mcgill.ca',
    'www.uvic.ca',
    'www.cs.queensu.ca',
  ],
  Australia: ['www.sydney.edu.au', 'www.unsw.edu.au', 'www.rmit.edu.au', 'www.curtin.edu.au'],
  China: ['ac.cs.tsinghua.edu.cn'],
  Japan: [
    'www.kyoto-u.ac.jp',
    'www.agent.soc.i.kyoto-u.ac.jp',
    'www.s-im.t.kyoto-u.ac.jp',
    'www.i.kyoto-u.ac.jp',
    'www.kurims.kyoto-u.ac.jp',
    'www.media.kyoto-u.ac.jp',
    'global.k.kyoto-u.ac.jp',
  ],
  'South Korea': ['cs.kaist.ac.kr'],
  'United States': [
    'siebelschool.illinois.edu',
    'www.cs.cmu.edu',
    'www.cs.stanford.edu',
    'www.eecs.mit.edu',
    'www2.eecs.berkeley.edu',
    'www.cs.washington.edu',
  ],
  'New Zealand': ['www.cs.auckland.ac.nz', 'cs.auckland.ac.nz', 'www.auckland.ac.nz'],
  Switzerland: ['inf.ethz.ch', 'www.epfl.ch', 'www.ifi.uzh.ch', 'www.inf.unibe.ch'],
  Portugal: ['tecnico.ulisboa.pt'],
  Italy: ['www.polimi.it', 'www.polito.it', 'www.di.uniroma1.it', 'disi.unibo.it', 'di.unipi.it', 'www.unipd.it'],
  'Bosnia and Herzegovina': ['www-ng.etf.unsa.ba'],
  Bulgaria: ['tu-sofia.bg'],
  Croatia: ['www.fer.unizg.hr'],
  Czechia: ['cs.fel.cvut.cz'],
  Denmark: ['orbit.dtu.dk'],
  Estonia: ['taltech.ee'],
  Finland: ['www.aalto.fi'],
  France: ['iut-sceaux.universite-paris-saclay.fr', 'www.ens.psl.eu', 'informatique.ens-lyon.fr'],
  Germany: ['www.cs.cit.tum.de', 'www.uni-mannheim.de', 'www.tu.berlin', 'www.rwth-aachen.de', 'www.uni-heidelberg.de', 'www.f05.uni-stuttgart.de'],
  Greece: ['robotics.ntua.gr'],
  Hungary: ['compsci.elte.hu'],
  Iceland: ['www.ru.is'],
  Ireland: ['www.tcd.ie'],
  Latvia: ['research.lu.lv'],
  Liechtenstein: ['www.uni.li'],
  Lithuania: ['mif.vu.lt'],
  Luxembourg: ['www.uni.lu'],
  Malta: ['www.um.edu.mt'],
  Moldova: ['fcim.utm.md'],
  Montenegro: ['www.ucg.ac.me'],
  Netherlands: ['vu.nl', 'www.uu.nl', 'www.tudelft.nl', 'www.rug.nl', 'www.tue.nl'],
  Norway: ['ntnu.edu'],
  Poland: ['mimuw.edu.pl'],
  Russia: ['cs.msu.ru', 'asvk.cs.msu.ru'],
  Serbia: ['etf.bg.ac.rs'],
  Slovakia: ['fiit.stuba.sk'],
  Slovenia: ['fri.uni-lj.si'],
  Spain: ['etsiit.ugr.es'],
  Sweden: ['kth.se', 'www.chalmers.se', 'www.uu.se', 'www.cs.lth.se'],
  Ukraine: ['csc.knu.ua'],
  'United Kingdom': ['cst.cam.ac.uk', 'www.cs.ox.ac.uk', 'www.gla.ac.uk', 'warwick.ac.uk', 'www.kcl.ac.uk', 'www.bristol.ac.uk'],
} as const;

/** Institution associated with each covered region's reviewed exact-host evidence. */
export const OFFICIAL_INSTITUTION_BY_REGION: Record<keyof typeof OFFICIAL_HOSTS_BY_REGION, string> = {
  Belgium: 'KU Leuven', Canada: 'University of Waterloo', Australia: 'The University of Sydney', China: 'Tsinghua University',
  Japan: 'Kyoto University', 'South Korea': 'KAIST', 'United States': 'University of Illinois Urbana-Champaign',
  'New Zealand': 'University of Auckland', Switzerland: 'ETH Zurich', Portugal: 'University of Lisbon', Italy: 'Politecnico di Milano',
  'Bosnia and Herzegovina': 'University of Sarajevo', Bulgaria: 'Technical University of Sofia', Croatia: 'University of Zagreb',
  Czechia: 'Czech Technical University in Prague', Denmark: 'Technical University of Denmark', Estonia: 'Tallinn University of Technology',
  Finland: 'Aalto University', France: 'Paris-Saclay University', Germany: 'Technical University of Munich',
  Greece: 'National Technical University of Athens', Hungary: 'Eötvös Loránd University', Iceland: 'Reykjavik University',
  Ireland: 'Trinity College Dublin', Latvia: 'University of Latvia', Liechtenstein: 'University of Liechtenstein',
  Lithuania: 'Vilnius University', Luxembourg: 'University of Luxembourg', Malta: 'University of Malta',
  Moldova: 'Technical University of Moldova', Montenegro: 'University of Montenegro', Netherlands: 'Vrije Universiteit Amsterdam',
  Norway: 'Norwegian University of Science and Technology', Poland: 'University of Warsaw', Russia: 'Lomonosov Moscow State University',
  Serbia: 'University of Belgrade', Slovakia: 'Slovak University of Technology in Bratislava', Slovenia: 'University of Ljubljana',
  Spain: 'University of Granada', Sweden: 'KTH Royal Institute of Technology', Ukraine: 'Taras Shevchenko National University of Kyiv',
  'United Kingdom': 'University of Cambridge',
};

/**
 * Institution for an exact host when a region covers more than one university.
 * Every host added by the 2026-11-20 expansion has an entry here so saved
 * professors are not attributed to another region's original institution.
 */
export const OFFICIAL_INSTITUTION_BY_HOST = {
  'www.cs.cmu.edu': 'Carnegie Mellon University',
  'www.cs.stanford.edu': 'Stanford University',
  'www.eecs.mit.edu': 'Massachusetts Institute of Technology',
  'www2.eecs.berkeley.edu': 'University of California, Berkeley',
  'www.cs.washington.edu': 'University of Washington',
  'www.cs.ox.ac.uk': 'University of Oxford',
  'www.gla.ac.uk': 'University of Glasgow',
  'warwick.ac.uk': 'University of Warwick',
  'www.kcl.ac.uk': "King's College London",
  'www.bristol.ac.uk': 'University of Bristol',
  'www.cs.toronto.edu': 'University of Toronto',
  'www.cs.ubc.ca': 'University of British Columbia',
  'www.cs.mcgill.ca': 'McGill University',
  'www.uvic.ca': 'University of Victoria',
  'www.cs.queensu.ca': "Queen's University",
  'www.uni-mannheim.de': 'University of Mannheim',
  'www.tu.berlin': 'Technische Universität Berlin',
  'www.rwth-aachen.de': 'RWTH Aachen University',
  'www.uni-heidelberg.de': 'Heidelberg University',
  'www.f05.uni-stuttgart.de': 'University of Stuttgart',
  'www.unsw.edu.au': 'UNSW Sydney',
  'www.rmit.edu.au': 'RMIT University',
  'www.curtin.edu.au': 'Curtin University',
  'www.uu.nl': 'Utrecht University',
  'www.tudelft.nl': 'Delft University of Technology',
  'www.rug.nl': 'University of Groningen',
  'www.tue.nl': 'Eindhoven University of Technology',
  'www.epfl.ch': 'École Polytechnique Fédérale de Lausanne',
  'www.ifi.uzh.ch': 'University of Zurich',
  'www.inf.unibe.ch': 'University of Bern',
  'www.chalmers.se': 'Chalmers University of Technology',
  'www.uu.se': 'Uppsala University',
  'www.cs.lth.se': 'Lund University',
  'www.ens.psl.eu': 'École Normale Supérieure – PSL',
  'informatique.ens-lyon.fr': 'École Normale Supérieure de Lyon',
  'www.polito.it': 'Politecnico di Torino',
  'www.di.uniroma1.it': 'Sapienza University of Rome',
  'disi.unibo.it': 'University of Bologna',
  'di.unipi.it': 'University of Pisa',
  'www.unipd.it': 'University of Padua',
} as const;

const INSTITUTION_BY_HOST: Record<string, string> = OFFICIAL_INSTITUTION_BY_HOST;

/**
 * Resolves the reviewed institution for an exact official host and falls back
 * to the region mapping, which stays authoritative for single-university regions.
 */
export function institutionForOfficialSource(region: string, sourceUrl: string): string | undefined {
  let host: string | undefined;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    host = undefined;
  }
  const byHost = host ? INSTITUTION_BY_HOST[host] : undefined;
  if (byHost) return byHost;
  return OFFICIAL_INSTITUTION_BY_REGION[region as keyof typeof OFFICIAL_INSTITUTION_BY_REGION];
}
