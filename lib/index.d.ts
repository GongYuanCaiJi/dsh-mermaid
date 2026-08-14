export declare const name = "dsh-mermaid";
export declare const SUPPORTED_TYPE_LABEL = "graph/flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram(-v2)";
export declare function normalizeMermaidSource(source: any): any;
export declare function formatIssueLines(issues: any, hash: any): any;
export declare function buildContextContent(block: any, hash: any, issues: any, includeSource: any): any;
export declare function extractText(content: any): string;
export declare function extractMermaidBlocks(text: any, maxBlocks?: number): any[];
export declare function getMermaidTypeToken(block: any): any;
export declare function getSupportedMermaidType(block: any): {
    token: any;
    normalized: string;
};
export declare function hashMermaid(block: any): string;
export declare function splitIssuesFromContent(text: any): {
    ascii: any;
    issues: any[];
};
export declare function getLastAssistantText(entries: any): string;
/** In-memory per-(session, turn) store; served to the web client. */
export declare function createRenderStore(): {
    /** Record the rendered results for a (session, turn). */
    set(sessionId: any, turn: any, results: any): void;
    /** Read results for a (session, turn); undefined when nothing rendered. */
    get(sessionId: any, turn: any): any;
    /** All turns recorded for a session, newest first. */
    list(sessionId: any): {
        turn: any;
        results: any;
    }[];
};
export declare function apply(ctx: any): void;
