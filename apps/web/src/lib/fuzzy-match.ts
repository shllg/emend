/** Scores each word's best subsequence independently, so query word order does not matter. */
export function fuzzyMatch(query: string, text: string): number | null {
  const words = query.toLowerCase().match(/\S+/g) ?? [];
  const lower = text.toLowerCase();
  let total = 0;
  for (const word of words) {
    let previous: number[] = [];
    for (let letter = 0; letter < word.length; letter++) {
      const scores = new Array<number>(lower.length).fill(-Infinity);
      let bestEarlier = -Infinity;
      for (let index = 0; index < lower.length; index++) {
        const adjacent = previous[index - 1] ?? -Infinity;
        bestEarlier = Math.max(bestEarlier, adjacent);
        if (lower[index] !== word[letter]) continue;
        const boundary = index === 0 || !/[a-z0-9]/.test(lower.charAt(index - 1)) ? 6 : 0;
        // Keep every ending position: a later match may gain a consecutive-letter or word-start bonus.
        scores[index] = 10 + boundary + (letter === 0 ? -index * 0.01 : Math.max(bestEarlier, adjacent + 8));
      }
      previous = scores;
    }
    const best = previous.reduce((best, score) => Math.max(best, score), -Infinity);
    if (best === -Infinity) return null;
    total += best;
  }
  return total;
}
