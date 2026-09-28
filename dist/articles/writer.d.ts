import type { Usage } from "@earendil-works/pi-ai";
import { type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
export type ArticleWriterModels = Pick<ModelRuntime, "streamSimple">;
/** Generate prose on the provider's text stream, never inside tool arguments. */
export declare function writeArticleText(options: {
    models: ArticleWriterModels;
    context: ExtensionContext;
    toolCallId: string;
    title: string;
    instruction: string;
    previous?: string;
    signal?: AbortSignal;
    onText: (text: string) => void;
}): Promise<{
    text: string;
    usage: Usage;
}>;
//# sourceMappingURL=writer.d.ts.map