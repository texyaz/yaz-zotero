/**
 * What Zotero actually puts on a drag, and how to read it.
 *
 * # There are two copies of every drop, and only one of them is usable
 *
 * Drag a source out of Zotero and you get a formatted reference:
 *
 * > DIN EN ISO 29481-1 IDM Bauwerksinformationsmodelle Handbuch der
 * > Informationslieferungen, Jan. 2025.
 *
 * Drag a highlight and you get the passage with a parenthetical after it:
 *
 * > “Grundflächen, die als Ergänzungsflächen … erforderlich sind”
 * > (“DIN 277, Grundflächen und Rauminhalte im Hochbau”, p. 8)
 *
 * Both of those are **prose**. Turning either back into `\cite{key}` means
 * guessing which library item the words describe, and a citation tool that
 * guesses is worse than one that declines — a wrong key compiles perfectly and
 * cites the wrong work.
 *
 * But that is only the `text/plain` flavour. The same drag also carries
 * `text/html`, and there Zotero attaches the machine-readable version of what
 * it just formatted: `data-annotation` on the highlight and `data-citation` on
 * the parenthetical, each holding URI-encoded JSON that names the actual
 * library item. That is what this reads.
 *
 * # Why not ask the user to change their Zotero settings
 *
 * Because it is not our application to configure. Zotero's Quick Copy format is
 * one setting shared by every program the user drags into, and rewriting it —
 * whether by asking or through an API — would change what they get in Word and
 * in their notes for the sake of what they get here. The machine-readable data
 * is present whatever that setting says, so nobody has to choose.
 *
 * # What is left over
 *
 * A drag that carries no machine data at all falls through to
 * {@link ZoteroDropText}, and the plugin tries once to find the item in the
 * library by what the text says. That *is* a guess — so it is only taken when
 * exactly one item matches, and otherwise the words go in as words.
 */

/** A passage the reader marked, dragged out of the PDF reader. */
export interface ZoteroDropAnnotation {
  kind: "annotation";
  /** The citable work, from the citation the drag carried alongside it. */
  itemKey: string | null;
  /** Zotero's own key for the mark, where it gave one. */
  annotationKey: string | null;
  /** The marked words, with the quotation marks Zotero added taken off. */
  text: string;
  /** The page as the document labels it, which is not always a number. */
  pageLabel: string | null;
}

/** One or more sources, dragged out of the library. */
export interface ZoteroDropCitation {
  kind: "citation";
  /** In the order they were dragged; a multiple selection cites several works. */
  items: { itemKey: string; locator: string | null }[];
}

/** A drag that carried no machine data: prose, and nothing else. */
export interface ZoteroDropText {
  kind: "text";
  text: string;
}

/** What a drag out of Zotero turned out to be. */
export type ZoteroDrop =
  | ZoteroDropAnnotation
  | ZoteroDropCitation
  | ZoteroDropText;

/**
 * The item key at the end of a Zotero URI.
 *
 * `http://zotero.org/users/12345/items/ABCD1234` and
 * `http://zotero.org/groups/98765/items/ABCD1234` both end in the key, and the
 * middle differs by which library the item is in — which is exactly the part
 * that does not matter here, because the library is already open.
 */
export function itemKeyFromUri(uri: string): string | null {
  const match = /\/items\/([A-Z0-9]{6,})\s*$/i.exec(uri.trim());
  return match ? match[1]! : null;
}

/** Decode one of Zotero's URI-encoded JSON attributes. */
function decode(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value)) as unknown;
  } catch {
    // A payload we cannot read is a payload we decline, not an error: the drop
    // still has its text and the caller falls back to that.
    return null;
  }
}

/** Read a string field, treating an empty one as absent. */
function field(source: unknown, name: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The item keys and locators a `data-citation` blob names. */
function citedItems(
  citation: unknown,
): { itemKey: string; locator: string | null }[] {
  if (typeof citation !== "object" || citation === null) return [];
  const raw = (citation as Record<string, unknown>).citationItems;
  if (!Array.isArray(raw)) return [];

  const items: { itemKey: string; locator: string | null }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const uris = (entry as Record<string, unknown>).uris;
    if (!Array.isArray(uris)) continue;
    // Zotero lists several URIs for one item — the same work in the user's own
    // library and in a group — and any of them identifies it.
    for (const uri of uris) {
      const key = typeof uri === "string" ? itemKeyFromUri(uri) : null;
      if (!key) continue;
      items.push({ itemKey: key, locator: field(entry, "locator") });
      break;
    }
  }
  return items;
}

/**
 * The quotation marks Zotero wraps a dragged highlight in.
 *
 * Taken off because the LaTeX that goes in adds its own, and the document's own
 * language decides which ones those are — a German document wants „low-high“
 * and a French one wants « guillemets ». Leaving Zotero's in would print two
 * sets, one of them wrong.
 */
const QUOTES = ['"', "'", "“", "”", "„", "«", "»"];

/** Strip the marks and collapse the line breaks PDF extraction leaves behind. */
export function unquote(text: string): string {
  let trimmed = text.replace(/\s+/g, " ").trim();
  while (trimmed.length > 1 && QUOTES.includes(trimmed[0]!)) {
    trimmed = trimmed.slice(1).trimStart();
  }
  while (trimmed.length > 1 && QUOTES.includes(trimmed[trimmed.length - 1]!)) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  return trimmed;
}

/**
 * Read a drag out of Zotero.
 *
 * `html` is the `text/html` flavour and `text` the `text/plain` one. Neither is
 * required: without the HTML there is no machine data and this says so, which
 * is the honest answer rather than a guess dressed up as a citation.
 */
export function readZoteroDrop(html: string, text: string): ZoteroDrop {
  const plain = text.replace(/\s+/g, " ").trim();
  if (!html) return { kind: "text", text: plain };

  let document: Document;
  try {
    document = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return { kind: "text", text: plain };
  }

  const citation = decode(
    document.querySelector("[data-citation]")?.getAttribute("data-citation") ??
      null,
  );

  // An annotation first: a dragged highlight carries *both* attributes, and the
  // passage is the point of it — treating it as a bare citation would drop the
  // words the reader marked.
  const marked = document.querySelector("[data-annotation]");
  if (marked) {
    const annotation = decode(marked.getAttribute("data-annotation"));
    const cited = citedItems(citation);
    const inner = (annotation as Record<string, unknown> | null)?.[
      "citationItem"
    ];
    return {
      kind: "annotation",
      itemKey:
        cited[0]?.itemKey ?? citedItems({ citationItems: [inner] })[0]?.itemKey ?? null,
      annotationKey: field(annotation, "annotationKey"),
      // The words are in the element, not in the blob: Zotero puts the payload
      // on the span and the passage inside it.
      text: unquote(marked.textContent ?? ""),
      pageLabel: field(annotation, "pageLabel") ?? cited[0]?.locator ?? null,
    };
  }

  const cited = citedItems(citation);
  if (cited.length > 0) return { kind: "citation", items: cited };

  // No machine data. Prefer the plain flavour, which is what the author saw
  // themselves dragging; fall back to the rendered HTML where there was none.
  return {
    kind: "text",
    text: plain || (document.body.textContent ?? "").replace(/\s+/g, " ").trim(),
  };
}
