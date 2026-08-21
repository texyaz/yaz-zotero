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
