const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with', 'research', 'researches', 'work', 'works', 'study', 'studies', 'approach', 'approaches', 'systems', 'system']);

/** Matches saved interests independently so evidence matching any one interest is sufficient. */
export function matchingResearchInterests(quote: string, interests: string[]): string[] {
  const quoteTokens = new Set(tokens(quote));
  return [...new Set(interests.map((interest) => interest.trim()).filter(Boolean))].filter((interest) => {
    const interestTokens = [...new Set(tokens(interest).filter((token) => !STOP_WORDS.has(token)))];
    if (!interestTokens.length) return false;
    const matched = interestTokens.filter((token) => quoteTokens.has(token)).length;
    const required = interestTokens.length === 1 ? 1 : interestTokens.length === 2 ? 2 : Math.ceil(interestTokens.length * 2 / 3);
    return matched >= required;
  });
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];
}
