/**
 * The LaTeX a citation or a quotation turns into.
 *
 * Its own module because there are now two ways in — the picker and a drag out
 * of Zotero — and they must produce exactly the same thing. A drop that wrote
 * slightly different LaTeX from the command would be a second dialect of the
 * same document, and the author would have to know which half they were
 * looking at.
 */

/** A backslash, so the escapes below read as what they are. */
const B = String.fromCharCode(92);

/**
 * Escape the characters that are syntax in LaTeX.
 *
 * Highlighted text is arbitrary prose lifted out of a PDF, and prose contains
 * `%` and `&`. A stray `%` comments out the rest of the line, which breaks the
 * build in a way that looks nothing like its cause.
 */
export function escapeLatex(text: string): string {
  // One pass, not two. Escaping backslashes in a second pass would also escape
  // the backslashes the first pass just introduced.
  const replacements: Record<string, string> = {
    [B]: `${B}textbackslash{}`,
    "~": `${B}textasciitilde{}`,
    "^": `${B}textasciicircum{}`,
    "&": `${B}&`,
    "%": `${B}%`,
    $: `${B}$`,
    "#": `${B}#`,
    _: `${B}_`,
    "{": `${B}{`,
    "}": `${B}}`,
  };
  return text.replace(
    /[\\~^&%$#_{}]/g,
    (character) => replacements[character]!,
  );
}

/** `\cite{key}`, with the page where there is one. */
export function citation(key: string, pageLabel?: string | null): string {
  return pageLabel
    ? `${B}cite[${escapeLatex(pageLabel)}]{${key}}`
    : `${B}cite{${key}}`;
}

/** `\cite{a,b}` for several works cited together for one claim. */
export function citations(keys: readonly string[]): string {
  return `${B}cite{${keys.join(",")}}`;
}

/**
 * A quoted passage, attributed.
 *
 * `csquotes`' `\textquote` rather than raw quotation marks, because it gets the
 * marks right for the document's language — German wants „low-high“ and French
 * wants « guillemets », and hardcoding `` '' `` produces a document that is
 * wrong in a way the author may not notice.
 */
export function quotation(
  text: string,
  key: string,
  pageLabel?: string | null,
): string {
  const passage = escapeLatex(text.replace(/\s+/g, " ").trim());
  return `${B}textquote[${citation(key, pageLabel)}]{${passage}}`;
}

/**
 * A passage with no source we could identify.
 *
 * Quoted, because it is still a quotation and the marks are still the
 * document's to choose — but with nothing in the brackets, because inventing a
 * key would be worse than leaving the attribution for the author to add.
 */
export function unattributed(text: string): string {
  return `${B}textquote{${escapeLatex(text.replace(/\s+/g, " ").trim())}}`;
}

/**
 * A picture marked in a source, as the figure that cites it.
 *
 * The citation goes in the caption rather than beside the image, because that
 * is where a reader of the printed page looks for where a figure came from —
 * and because a `\\cite` floating next to an `\\includegraphics` prints in
 * whatever place the float lands, which is nowhere in particular.
 *
 * The caption is otherwise left empty. Only the author knows what the picture
 * shows, and they will never be better placed to say so than at the moment they
 * dragged it in.
 */
export function figureFromSource(
  path: string,
  citationKey: string,
  pageLabel: string | null,
): string {
  const cite = pageLabel
    ? `${B}cite[${pageLabel}]{${citationKey}}`
    : `${B}cite{${citationKey}}`;
  return [
    `${B}begin{figure}[h]`,
    `  ${B}centering`,
    `  ${B}includegraphics[width=0.8${B}textwidth]{${path}}`,
    `  ${B}caption{${cite}}`,
    `  ${B}label{fig:}`,
    `${B}end{figure}`,
  ].join("\n");
}

/**
 * The citation key under the cursor, or null when the cursor is on no citation.
 *
 * Any command whose name contains `cite` — `\cite`, `\parencite[8]{…}`,
 * `\textcite`, `\citet`, `\autocite[see][12]{…}` — because biblatex and natbib
 * between them have dozens and a list would always be one short. With several
 * keys, `\cite{a, b}`, it is the one the cursor is in; on the command name or
 * its options, the first.
 *
 * Only a window around the cursor is read. This runs when a command is
 * invoked, never per keystroke (ADR-0027), but a long thesis is still no
 * reason to scan all of it for one citation.
 */
export function citationKeyAt(text: string, offset: number): string | null {
  const WINDOW = 2000;
  const start = Math.max(0, offset - WINDOW);
  const slice = text.slice(start, offset + WINDOW);
  const at = offset - start;
  const pattern =
    /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/g;
  for (const match of slice.matchAll(pattern)) {
    const from = match.index;
    const to = from + match[0].length;
    if (at < from || at > to) continue;
    const keysStart = to - 1 - match[1]!.length;
    let position = keysStart;
    let first: string | null = null;
    for (const raw of match[1]!.split(",")) {
      const key = raw.trim();
      if (key && first === null) first = key;
      if (key && at >= position && at <= position + raw.length) return key;
      position += raw.length + 1;
    }
    return first;
  }
  return null;
}

/** The `\ai[KEYS]{…}` / `\proofed[KEYS]{…}` marker around a position. */
export interface AnnotationMark {
  /** `ai` (written by AI, not yet checked) or `proofed` (checked by a human). */
  kind: "ai" | "proofed";
  /** The Zotero annotation keys in the optional argument, in order. */
  keys: string[];
  /** The key the cursor is on, when it is inside the optional argument. */
  keyAtCursor: string | null;
}

/**
 * The white-box marker (ADR-0030) whose span contains `offset`, innermost
 * first, or `null` when the position is in no marker.
 *
 * The span runs from the backslash to the brace that closes the sentence, so
 * the cursor can be anywhere in the sentence, its citation, or the keys. Braces
 * are matched, and `\{` / `\}` are not braces. Only a window around the cursor
 * is read: a marked sentence is a sentence, not a chapter.
 */
export function annotationMarkAt(
  text: string,
  offset: number,
): AnnotationMark | null {
  const BEFORE = 8000;
  const AFTER = 8000;
  const start = Math.max(0, offset - BEFORE);
  const slice = text.slice(start, offset + AFTER);
  const at = offset - start;
  const pattern = /\\(ai|proofed)\s*\[([^\]]*)\]\s*\{/g;
  let best: AnnotationMark | null = null;
  for (const match of slice.matchAll(pattern)) {
    const from = match.index;
    if (from > at) break;
    const bodyOpen = from + match[0].length - 1;
    const close = matchingBrace(slice, bodyOpen);
    if (close === null || at > close + 1) continue;
    const keysFrom = from + match[0].indexOf("[") + 1;
    let position = keysFrom;
    let keyAtCursor: string | null = null;
    const keys: string[] = [];
    for (const raw of match[2]!.split(",")) {
      const key = raw.trim();
      if (key) {
        keys.push(key);
        if (at >= position && at <= position + raw.length) keyAtCursor = key;
      }
      position += raw.length + 1;
    }
    // A later opening that still contains the cursor is nested inside this
    // one, so it is the more precise answer.
    best = { kind: match[1] as "ai" | "proofed", keys, keyAtCursor };
  }
  return best;
}

/** Index of the `}` closing the `{` at `open`, or `null` if it is not closed. */
function matchingBrace(text: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return null;
}

/** Whether `key` has the shape of a Zotero key: eight of A–Z and 0–9. */
export function isAnnotationKey(key: string): boolean {
  return /^[A-Z0-9]{8}$/.test(key);
}
