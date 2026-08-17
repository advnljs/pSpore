import { tokenize } from "./tokenizer.js";
export function rankBm25(query, documents, options = {}) {
    if (documents.length === 0)
        return [];
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0)
        return [];
    const k1 = options.k1 ?? 1.2;
    const b = options.b ?? 0.75;
    const tokenized = documents.map((document) => ({ document, tokens: tokenize(document.text) }));
    const averageLength = tokenized.reduce((sum, item) => sum + item.tokens.length, 0) / tokenized.length || 1;
    const documentFrequency = new Map();
    for (const token of queryTokens) {
        documentFrequency.set(token, tokenized.filter((item) => item.tokens.includes(token)).length);
    }
    const scores = [];
    for (const item of tokenized) {
        const frequencies = frequenciesOf(item.tokens);
        let score = 0;
        for (const token of queryTokens) {
            const frequency = frequencies.get(token) ?? 0;
            if (frequency === 0)
                continue;
            const foundIn = documentFrequency.get(token) ?? 0;
            const inverseDocumentFrequency = Math.log(1 + (documents.length - foundIn + 0.5) / (foundIn + 0.5));
            const denominator = frequency + k1 * (1 - b + b * (item.tokens.length / averageLength));
            score += inverseDocumentFrequency * ((frequency * (k1 + 1)) / denominator);
        }
        if (score > 0)
            scores.push({ id: item.document.id, score });
    }
    return scores.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
function frequenciesOf(tokens) {
    const frequencies = new Map();
    for (const token of tokens)
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    return frequencies;
}
//# sourceMappingURL=bm25.js.map