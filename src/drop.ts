/**
 * What Zotero actually puts on a drag, and how to read it.
 *
 * # There are two copies of every drop, and one of them is machine-readable
 *
 * Drag a source out of Zotero and you get a formatted reference, in whatever
 * citation style is set:
 *
 * > [1] DIN EN ISO 29481-1 IDM Bauwerksinformationsmodelle Handbuch der
 * > Informationslieferungen, Jan. 2025.
 *
 * Drag a highlight and you get the passage with a parenthetical after it:
 *
 * > “Grundflächen, die als Ergänzungsflächen … erforderlich sind”
 * > ([“DIN 277, Grundflächen und Rauminhalte im Hochbau”, p. 8](zotero://select/groups/6292579/items/B8IM9SU5))
 * > ([pdf](zotero://open-pdf/groups/6292579/items/4JUK7QZT?page=8&annotation=FARPUJ53))
 *
 * The prose is prose: turning it back into `\cite{key}` means guessing which
 * library item the words describe, and a citation tool that guesses is worse
 * than one that declines — a wrong key compiles perfectly and cites the wrong
 * work. But **the links are not prose.** `zotero://select/.../items/B8IM9SU5`
 * names the item, and `zotero://open-pdf/...?page=8&annotation=FARPUJ53` names
 * the page and the mark. That is machine data, and it is what this reads.
 *
 * # Two shapes, because Quick Copy has a setting
 *
 * Which of these a drag carries depends on the user's Quick Copy format, and
 * both are read:
 *
 * | Quick Copy | What arrives | Where the item key is |
 * | --- | --- | --- |
 * | A citation style | `data-citation` / `data-annotation` on the HTML | URI-encoded JSON |
 * | A Markdown format | `zotero://` links | the link itself |
 *
 * The attributes are tried first because they carry more — a locator, the
 * annotation's own key — and the links are the fallback. Neither requires the
 * user to have set anything up.
 *
 * # Why not ask the user to change their Zotero settings
 *
 * Because it is not our application to configure. Quick Copy is one setting
 * shared by every program the user drags into, and rewriting it — whether by
 * asking or through an API — would change what they get in Word and in their
 * notes for the sake of what they get here. Reading both shapes means nobody
 * has to choose.
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
 * The item key in a Zotero URI.
 *
 * Four shapes reach this, and the key sits in the same place in all of them:
 *
 * - `http://zotero.org/users/12345/items/ABCD1234`
 * - `http://zotero.org/groups/98765/items/ABCD1234`
 * - `zotero://select/groups/6292579/items/B8IM9SU5`
 * - `zotero://open-pdf/groups/6292579/items/4JUK7QZT?page=8`
 *
 * What differs is the library the item is in, which is exactly the part that
 * does not matter — the library is already open — and a trailing query, which
 * belongs to the mark rather than to the item.
 */
export function itemKeyFromUri(uri: string): string | null {
  const match = /\/items\/([A-Z0-9]{6,})(?:[?#]|\s*$)/i.exec(uri.trim());
  return match ? match[1]! : null;
}

/**
 * Every `zotero://` link in a piece of text, in the order they appear.
 *
 * Found by scanning rather than by parsing markdown or HTML, because the same
 * links arrive both ways — as `[label](zotero://…)` in a Markdown Quick Copy's
 * plain text and as `href="zotero://…"` in its HTML — and the surrounding
 * syntax is not what identifies them.
 */
export function zoteroLinks(text: string): string[] {
  return [...text.matchAll(/zotero:\/\/[^\s)"'<>\]]+/g)].map((match) =>
    match[0],
  );
}

/**
 * One value out of a URI's query string.
 *
 * By hand rather than with `URL`, because `zotero://` is not a hierarchical
 * scheme the URL parser gives up a `searchParams` for — it parses as opaque and
 * the query comes back empty.
 */
function parameter(uri: string, name: string): string | null {
  const query = uri.slice(uri.indexOf("?") + 1);
  if (!uri.includes("?")) return null;
  for (const pair of query.split("&")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    if (pair.slice(0, at) !== name) continue;
    const value = decodeURIComponent(pair.slice(at + 1)).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * The passage, with the links Zotero appended taken off the end of it.
 *
 * A Markdown Quick Copy renders the attribution as trailing markdown links —
 * `([“DIN 277…”, p. 8](zotero://select/…)) ([pdf](zotero://open-pdf/…))` — and
 * those are the machine data read above, not words the author is quoting.
 * Leaving them in the buffer would put a URI in the middle of a sentence.
 */
export function withoutLinks(text: string): string {
  return text
    // The markdown form, label and target together.
    .replace(/\[[^\]]*\]\(zotero:\/\/[^)]*\)/g, "")
    // A bare link, for a format that emitted one without a label.
    .replace(/zotero:\/\/[^\s)"'<>\]]+/g, "")
    // What the removals leave behind: the parentheses that wrapped them.
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read `zotero://` links out of any text that might hold some.
 *
 * For a flavour the main reader does not look at — `text/uri-list`, which some
 * drags carry and others do not. Returns `null` when there is nothing there,
 * which is the common case and not a failure.
 */
export function readZoteroUris(text: string): ZoteroDrop | null {
  return fromLinks(zoteroLinks(text), text);
}

/**
 * Read a drag whose machine data is `zotero://` links rather than attributes.
 *
 * `select` names the citable work and `open-pdf` names the attachment the mark
 * is in — so the item key comes from the first and the page and the annotation
 * key from the second. Getting that the wrong way round would cite the PDF
 * rather than the work it is a copy of.
 */
function fromLinks(links: readonly string[], text: string): ZoteroDrop | null {
  if (links.length === 0) return null;

  const select = links.filter((link) => link.includes("/select/"));
  const opened = links.find((link) => link.includes("/open-pdf/"));
  const annotation = opened ? parameter(opened, "annotation") : null;

  // A mark: the passage is what was dragged, and the links are its attribution.
  if (annotation) {
    const passage = unquote(withoutLinks(text));
    return {
      kind: "annotation",
      itemKey: select.map(itemKeyFromUri).find(Boolean) ?? null,
      annotationKey: annotation,
      text: passage,
      pageLabel: opened ? parameter(opened, "page") : null,
    };
  }

  const items = select
    .map(itemKeyFromUri)
    .filter((key): key is string => key !== null)
    .map((itemKey) => ({ itemKey, locator: null }));
  return items.length > 0 ? { kind: "citation", items } : null;
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

  let document: Document | null = null;
  if (html) {
    try {
      document = new DOMParser().parseFromString(html, "text/html");
    } catch {
      document = null;
    }
  }

  const fromAttributes = document ? readAttributes(document) : null;
  if (fromAttributes) return fromAttributes;

  /*
   * No attributes, so try the links.
   *
   * The HTML first and the plain text second, because a Markdown Quick Copy's
   * HTML holds the same links in `href`s and its text is the rendered markdown
   * — and where only one flavour arrived, that one is all there is. Both are
   * scanned the same way, since what identifies a link is the link.
   */
  if (document) {
    // The `href` property rather than the markup: `innerHTML` gives the
    // attribute back with its `&` escaped as `&amp;`, which turns the query
    // `?page=8&annotation=…` into a parameter called `amp;annotation` and loses
    // the mark entirely.
    const hrefs = [...document.querySelectorAll("a[href]")]
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("zotero://"));

    /*
     * The words with the attribution taken out of them.
     *
     * The links have to come out as *elements* here rather than as text: in the
     * HTML flavour there is no `[label](target)` syntax to strip, so the
     * attribution would otherwise survive in its rendered form — `(“DIN 277…”,
     * p. 8) (pdf)` — glued onto the end of the quotation.
     *
     * On a copy, because the parsed document is not ours to damage.
     */
    const body = document.body.cloneNode(true) as HTMLElement;
    for (const anchor of body.querySelectorAll("a[href]")) {
      if ((anchor.getAttribute("href") ?? "").startsWith("zotero://")) {
        anchor.remove();
      }
    }

    const found = fromLinks(hrefs, body.textContent ?? "");
    if (found) return found;
  }

  const fromPlain = fromLinks(zoteroLinks(plain), plain);
  if (fromPlain) return fromPlain;

  // No machine data of either shape. Prefer the plain flavour, which is what
  // the author saw themselves dragging; fall back to the rendered HTML where
  // there was none.
  return {
    kind: "text",
    text:
      plain ||
      (document?.body.textContent ?? "").replace(/\s+/g, " ").trim(),
  };
}

/**
 * Read the `data-citation` and `data-annotation` attributes, where there are any.
 *
 * What a Quick Copy set to a *citation style* produces. Tried before the links
 * because it carries more: a locator the style chose, and the annotation's own
 * key.
 */
function readAttributes(document: Document): ZoteroDrop | null {
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
        cited[0]?.itemKey ??
        citedItems({ citationItems: [inner] })[0]?.itemKey ??
        null,
      annotationKey: field(annotation, "annotationKey"),
      // The words are in the element, not in the blob: Zotero puts the payload
      // on the span and the passage inside it.
      text: unquote(marked.textContent ?? ""),
      pageLabel: field(annotation, "pageLabel") ?? cited[0]?.locator ?? null,
    };
  }

  const cited = citedItems(citation);
  return cited.length > 0 ? { kind: "citation", items: cited } : null;
}
