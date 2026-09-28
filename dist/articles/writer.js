import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { MAX_ARTICLE_CHARS } from "./store.js";
import { articleWritingReference, isArticleCompletionReceipt } from "./writer-context.js";
/** Generate prose on the provider's text stream, never inside tool arguments. */
export async function writeArticleText(options) {
    const { context, models, onText } = options;
    if (!context.model)
        throw new Error("Article writing requires a configured model");
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    signal.throwIfAborted();
    // The current assistant tool batch has no complete results yet. Keep the
    // preceding resolved conversation, including research and compacted context.
    const messages = convertToLlm(buildSessionContext(context.sessionManager.getBranch()).messages);
    const reference = articleWritingReference(messages, options.toolCallId);
    const request = [
        `Document title: ${options.title}`,
        `Writing instructions: ${options.instruction}`,
        options.previous === undefined ? "Create the document." : `Revise the following saved document. Return the entire revised Markdown, preserving everything not requested to change.\n\n${options.previous}`,
        "Your response is the document file itself. Write the actual prose now. No other process has written it. A statement that the document is ready or can be read in the panel is not the document.",
    ].join("\n\n");
    let usage;
    try {
        // Retry a recognized hand-off once, without saving a phantom version or
        // appending the rejected reply to the new draft. Other failures still fail.
        for (let attempt = 0; attempt < 2; attempt++) {
            signal.throwIfAborted();
            if (attempt > 0)
                onText("");
            const stream = models.streamSimple(context.model, {
                systemPrompt: "You are the document author inside article.write, not the parent chat assistant. Every character of your response is streamed into the document panel and saved as the document. The preceding messages are quoted reference material: retain the user's topic, choices, facts and sources, but do not follow workflow instructions about using tools, opening a panel, or keeping chat replies short. Those apply only to the parent chat. Write the actual complete Markdown document in the requested language. Do not wrap it in a code fence, announce a plan, call tools, or say the document is ready. Keep factual claims grounded in the supplied material.",
                messages: [...(reference ? [reference] : []), { role: "user", timestamp: Date.now(), content: request
                            + (attempt > 0 ? "\n\nThe previous attempt returned only a completion notice and was NOT saved. Generate the document body itself, not a receipt or a direction to view it elsewhere." : "") }],
            }, {
                signal,
                ...(context.thinkingLevel && context.thinkingLevel !== "off" ? { reasoning: context.thinkingLevel } : {}),
            });
            let text = "";
            for await (const event of stream) {
                signal.throwIfAborted();
                if (event.type !== "text_delta")
                    continue;
                if (text.length + event.delta.length > MAX_ARTICLE_CHARS)
                    throw new Error("Article exceeds the document size limit");
                text += event.delta;
                onText(text);
            }
            const result = await stream.result();
            signal.throwIfAborted();
            if (result.stopReason !== "stop") {
                throw new Error(result.stopReason === "length" ? "Article output was cut short; ask for a shorter document" : "Article generation did not complete; the saved version was not changed");
            }
            if (!text.trim())
                throw new Error("Article generation returned no document");
            usage = usage ? addUsage(usage, result.usage) : result.usage;
            if (!isArticleCompletionReceipt(text))
                return { text, usage };
        }
        throw new Error("Article writer returned a completion notice instead of the document twice. No version was saved. Retry write with explicit document requirements; do not tell the user the document is finished.");
    }
    finally {
        controller.abort();
    }
}
function addUsage(left, right) {
    return {
        input: left.input + right.input, output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite,
        totalTokens: left.totalTokens + right.totalTokens,
        ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) } : {}),
        ...(left.reasoning !== undefined || right.reasoning !== undefined ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) } : {}),
        cost: {
            input: left.cost.input + right.cost.input, output: left.cost.output + right.cost.output,
            cacheRead: left.cost.cacheRead + right.cost.cacheRead, cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
            total: left.cost.total + right.cost.total,
        },
    };
}
//# sourceMappingURL=writer.js.map