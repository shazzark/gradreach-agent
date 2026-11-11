import type { DiscoveryEvidence, ProfessorCandidate } from '../domain/outreach-queue.ts';
import { safeOfficialSourceUrl } from './safe-source-url.ts';

const excerptPreviewLength = 260;

export function previewSavedExcerpt(excerpt: string): string {
  if (excerpt.length <= excerptPreviewLength) return excerpt;
  return `${excerpt.slice(0, excerptPreviewLength).trimEnd()}…`;
}

export function leadCardView(candidate: ProfessorCandidate) {
  return {
    pageTitle: candidate.name.trim() || 'Title unavailable',
    professorName: candidate.professorName?.trim() || 'Not established from an individual official profile',
    institution: candidate.institution?.trim() || 'Unknown',
    country: candidate.country?.trim() || 'Unknown',
    discoveryRegion: candidate.searchRegion?.trim() || candidate.discoveryEvidence?.find((item) => item.region.trim())?.region || 'Unknown',
    leadType: candidate.leadType || 'General / unclassified',
    status: candidate.status || 'Unknown',
    reviewDecision: candidate.discoveryReview?.decision || 'Not reviewed',
  };
}

export function evidenceCardView(item: DiscoveryEvidence) {
  return {
    sourceUrl: safeOfficialSourceUrl(item.sourceUrl),
    excerptPreview: previewSavedExcerpt(item.excerpt),
    fullExcerpt: item.excerpt,
    verification: item.verification || 'Unknown',
    retrievedDate: item.retrievedAt ? item.retrievedAt.slice(0, 10) : 'Date unavailable',
  };
}
