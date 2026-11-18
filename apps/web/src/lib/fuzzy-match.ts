/** Scores each word's best subsequence independently, so query word order does not matter. */
export function fuzzyMatch(query: string, text: string): number | null {
  const words = query.toLowerCase().match(/\S+/g) ?? [];
  const lower = text.toLowerCase();
  let total = 0;
  for (const word of words) {
    let previous = new Array<number>(lower.length).fill(-Infinity);
    let scores = new Array<number>(lower.length);
    for (let letter = 0; letter < word.length; letter++) {
      scores.fill(-Infinity);
      let bestEarlier = -Infinity;
      let hasMatch = false;
      for (let index = 0; index < lower.length; index++) {
        const adjacent = previous[index - 1] ?? -Infinity;
        bestEarlier = Math.max(bestEarlier, adjacent);
        if (lower[index] !== word[letter]) continue;
        const boundary = index === 0 || !/[a-z0-9]/.test(lower.charAt(index - 1)) ? 6 : 0;
        // Keep every ending position: a later match may gain a consecutive-letter or word-start bonus.
        scores[index] = 10 + boundary + (letter === 0 ? -index * 0.01 : Math.max(bestEarlier, adjacent + 8));
        if (Number.isFinite(scores[index])) hasMatch = true;
      }
      if (!hasMatch) return null;
      [previous, scores] = [scores, previous];
    }
    const best = previous.reduce((best, score, index) => {
      const boundary = index === lower.length - 1 || !/[a-z0-9]/.test(lower.charAt(index + 1)) ? 6 : 0;
      return Math.max(best, score + boundary);
    }, -Infinity);
    if (best === -Infinity) return null;
    total += best;
  }
  return total;
}

const queryWords = /\S+/g;

/** Each word uses its best field, without joining letters across fields. */
export function fuzzyMatchFields(query: string, texts: readonly string[]): number | null {
  let total = 0;
  for (const word of query.match(queryWords) ?? []) {
    let best: number | null = null;
    for (const text of texts) {
      const score = fuzzyMatch(word, text);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}
