/**
 * Tools an AI agent can call through yaz's MCP server (ADR-0022, ADR-0031).
 *
 * This plugin's part of the white-box writing loop is the library: finding
 * sources, their highlights and their citation keys. Writing into the paper
 * — only ever as `\ai[HIGHLIGHT]{…}` — is the AI writing plugin's
 * (`com.yaz.ai`, ADR-0032).
 */

import type { App } from "@yaz/api";

/** Highlights an AI made carry Zotero's purple. */
const AI_COLOUR = "#a28ae5";

/** What the plugin lends the tools: its own way of making a citation key. */
export interface AgentHost {
  app: App;
  citationKey(itemKey: string): Promise<string>;
}

/** A tool, in the shape `registerTool` takes. */
interface AgentTool {
  name: string;
  descriptionKey: string;
  schema?: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${name}" is required and must be text`);
  }
  return value;
}

export function agentTools(host: AgentHost): AgentTool[] {
  const { app } = host;
  return [
    {
      name: "search_library",
      descriptionKey: "zotero-tool-search-library",
      schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words from the title, author or year." },
          limit: { type: "number", description: "At most this many results (default 10)." },
        },
        required: ["query"],
      },
      async run(args) {
        const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50);
        const items = await app.zotero.search(text(args, "query"), limit);
        return items.map((item) => ({
          itemKey: item.key,
          citationKey: item.citationKey,
          title: item.title,
          creators: item.creators,
          year: item.year,
          container: item.container,
        }));
      },
    },
    {
      name: "list_highlights",
      descriptionKey: "zotero-tool-list-highlights",
      schema: {
        type: "object",
        properties: {
          itemKey: { type: "string", description: "The source's Zotero item key, from search_library." },
        },
        required: ["itemKey"],
      },
      async run(args) {
        const annotations = await app.zotero.listAnnotations(text(args, "itemKey"));
        return annotations.map((annotation) => ({
          highlightKey: annotation.key,
          kind: annotation.kind,
          text: annotation.text,
          comment: annotation.comment,
          page: annotation.pageLabel,
          madeByAi: annotation.color?.toLowerCase() === AI_COLOUR,
        }));
      },
    },
    {
      name: "add_to_bibliography",
      descriptionKey: "zotero-tool-add-to-bibliography",
      schema: {
        type: "object",
        properties: {
          itemKey: { type: "string", description: "The source's Zotero item key." },
        },
        required: ["itemKey"],
      },
      async run(args) {
        const key = await host.citationKey(text(args, "itemKey"));
        return { citationKey: key, cite: `\\cite{${key}}` };
      },
    },
  ];
}
