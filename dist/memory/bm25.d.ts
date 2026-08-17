export interface Bm25Document {
    id: string;
    text: string;
}
export interface Bm25Score {
    id: string;
    score: number;
}
export interface Bm25Options {
    k1?: number;
    b?: number;
}
export declare function rankBm25(query: string, documents: readonly Bm25Document[], options?: Bm25Options): Bm25Score[];
//# sourceMappingURL=bm25.d.ts.map