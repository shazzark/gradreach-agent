export interface ProfessorResearchEvidencePackage {
  /** Professor identity source; retained as sourceUrl for older consumers. */
  sourceUrl: string;
  identitySourceUrl?: string;
  researchSourceUrl?: string;
  checkedAt: string;
  professorName?: string;
  identityQuote?: string;
  researchQuote?: string;
  affiliation: { status: 'verified' | 'uncertain'; institution?: string; sourceUrl: string };
  matchedInterests: string[];
  recommendation: 'likely relevant' | 'uncertain' | 'unlikely';
  rationale: string;
  uncertaintyReasons: string[];
}
