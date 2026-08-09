const WORD_PATTERN = /[\p{L}\p{N}_]+/gu;
const HAN_PATTERN = /\p{Script=Han}/u;

export function tokenize(text: string, options: { forceCjkBigramFallback?: boolean } = {}): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("und");
  const tokens: string[] = [];
  for (const match of normalized.matchAll(WORD_PATTERN)) {
    const value = match[0];
    if (!HAN_PATTERN.test(value)) {
      tokens.push(value);
      continue;
    }
    tokens.push(...tokenizeCjk(value, options.forceCjkBigramFallback ?? false));
  }
  return tokens;
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of text.normalize("NFC")) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk += 1;
    else other += Buffer.byteLength(character, "utf8") > 1 ? 1 : character.trim() ? 1 : 0;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

function tokenizeCjk(value: string, forceFallback: boolean): string[] {
  if (!forceFallback && typeof Intl.Segmenter === "function") {
    const segments = new Intl.Segmenter("zh", { granularity: "word" }).segment(value);
    const words = [...segments]
      .filter((segment) => segment.isWordLike)
      .map((segment) => segment.segment)
      .filter(Boolean);
    if (words.length > 0) return words;
  }
  const characters = [...value].filter((character) => HAN_PATTERN.test(character));
  if (characters.length <= 1) return characters;
  return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1] ?? ""}`);
}
