/**
 * The Zotero core plugin.
 *
 * # This has no privileges
 *
 * It imports `@yaz/api` and nothing else, and every privileged call it makes is
 * refused by the capability broker in the Rust process before it does any work.
 * That is the whole point of shipping the Zotero bridge as a *plugin*
 * ([ADR-0005]): if the public API cannot express a demanding real feature, we
 * find out here rather than when an external author does.
 *
 * It did in fact find two gaps, both of which became public API rather than back
 * doors: `zotero.listAnnotations` and `ui.pick`.
 *
 * # What it does
 *
 * Two pickers, in sequence. The first chooses a source from the library. The
 * second chooses one of the passages the reader marked in that source, and is
 * skipped when there are none — offering an empty list is a worse answer than
 * simply inserting the citation.
 *
 * [ADR-0005]: https://generalpawz.github.io/yaz/adr/0005-extensibility-tiers
 */

import {
  Plugin,
  type PickerItem,
  type ZoteroAnnotation,
  type ZoteroItem,
} from "@yaz/api";

/** How many library rows to request per keystroke. */
const PAGE_SIZE = 50;

/** Longest passage shown in a picker row before it is elided. */
const PREVIEW_LENGTH = 240;

export default class ZoteroPlugin extends Plugin {
  async onload(): Promise<void> {
    this.addCommand({
      id: "cite",
      nameKey: "zotero-command-cite",
      descriptionKey: "zotero-command-cite-description",
      defaultHotkey: "Mod+Shift+C",
      isAvailable: () => this.app.editor !== null,
      callback: () => this.cite(false),
    });

    this.addCommand({
      id: "quote",
      nameKey: "zotero-command-quote",
      descriptionKey: "zotero-command-quote-description",
      defaultHotkey: "Mod+Shift+Q",
      isAvailable: () => this.app.editor !== null,
      callback: () => this.cite(true),
    });

    this.addCommand({
      id: "reconnect",
      nameKey: "zotero-command-reconnect",
      descriptionKey: "zotero-command-reconnect-description",
      callback: () => this.reconnect(),
    });
  }

  /**
   * Pick a source, optionally pick a marked passage, and insert.
   *
   * @param quoting - when true, go on to the passage picker.
   */
  private async cite(quoting: boolean): Promise<void> {
    const editor = this.app.editor;
    if (!editor) {
      this.app.notices.show("zotero-notice-no-editor");
      return;
    }

    const status = await this.app.zotero.status();
    if (status.kind === "none") {
      // Naming the directory that was consulted is the difference between an
      // actionable message and a shrug: the usual cause is a library that lives
      // somewhere other than where it was looked for.
      this.app.notices.show("zotero-notice-unavailable", {
        detail: status.dataDir ?? status.detail ?? "",
      });
      return;
    }

    const item = await this.pickItem();
    if (!item) return;

    let annotation: ZoteroAnnotation | null = null;
    if (quoting) {
      annotation = await this.pickAnnotation(item);
      // A dismissed passage picker cancels the whole insertion. Falling back to
      // a bare citation would silently do something other than what was asked.
      if (!annotation) return;
    }

    const citation = await this.app.zotero.ensureInBibliography(item.key);
    editor.insertAtCursor(
      annotation
        ? quotation(annotation, citation.key)
        : `\\cite{${citation.key}}`,
    );

    if (!citation.isAuthoritative) {
      // ADR-0008: without Better BibTeX the key is ours, and may not match what
      // a co-author's library produces. Better said now than discovered in
      // someone else's document.
      this.app.notices.show("zotero-notice-generated-key", {
        key: citation.key,
      });
    }
  }

  /** The source picker. */
  private pickItem(): Promise<ZoteroItem | null> {
    return this.app.ui.pick<ZoteroItem>({
      titleKey: "zotero-picker-source-title",
      placeholderKey: "zotero-picker-source-placeholder",
      emptyKey: "zotero-picker-source-empty",
      // A function rather than an array: the library is far too large to send at
      // once, so each keystroke is a query.
      items: async (query) => {
        const items = await this.app.zotero.search(query, PAGE_SIZE);
        return items.map((item): PickerItem<ZoteroItem> => ({
          value: item,
          label: item.title || item.key,
          description: describe(item),
          detail: item.container ?? undefined,
        }));
      },
    });
  }

  /** The marked-passage picker. */
  private async pickAnnotation(
    item: ZoteroItem,
  ): Promise<ZoteroAnnotation | null> {
    const all = await this.app.zotero.listAnnotations(item.key);
    // Ink and image marks cover a region and carry no text; a note is the
    // reader's own words, and quoting it as the source would misattribute it.
    const quotable = all.filter((a) => a.isQuotable);

    if (quotable.length === 0) {
      // Two calls rather than one with a conditional key: a key chosen inside an
      // expression is a key the i18n check cannot see, and an unverified message
      // key renders as the key itself (ADR-0011).
      if (all.length === 0) {
        this.app.notices.show("zotero-notice-no-annotations");
      } else {
        this.app.notices.show("zotero-notice-no-quotable-annotations");
      }
      return null;
    }

    return this.app.ui.pick<ZoteroAnnotation>({
      titleKey: "zotero-picker-passage-title",
      placeholderKey: "zotero-picker-passage-placeholder",
      emptyKey: "zotero-picker-passage-empty",
      // An array: the passages for one document are few enough to filter
      // locally, and doing so keeps typing instant.
      items: quotable.map((annotation): PickerItem<ZoteroAnnotation> => ({
        value: annotation,
        label: preview(annotation.text),
        description: annotation.pageLabel
          ? this.app.i18n.t("zotero-page-label", { page: annotation.pageLabel })
          : undefined,
        detail: annotation.comment ?? undefined,
        // The reader's own highlight colour. Many libraries encode meaning in
        // it — one colour for claims, another for method — and it is often
        // the only organisation the annotations have.
        accentColor: annotation.color ?? undefined,
      })),
    });
  }

  private async reconnect(): Promise<void> {
    await this.app.zotero.refresh();
    const status = await this.app.zotero.status();
    this.app.notices.show(status.sourceKey);
  }
}

/** Author and year, as a picker row's secondary text. */
function describe(item: ZoteroItem): string | undefined {
  const author = item.creators[0];
  const year = item.year;
  if (author && year) return `${author} (${year})`;
  if (author) return author;
  if (year) return String(year);
  return undefined;
}

/** Collapse whitespace and elide a long passage for display. */
function preview(text: string): string {
  // PDF text extraction leaves hard line breaks mid-sentence, so a raw
  // highlight is full of newlines that would wreck a single-line row.
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_LENGTH
    ? `${collapsed.slice(0, PREVIEW_LENGTH - 1)}…`
    : collapsed;
}

/**
 * Build the LaTeX for a quoted passage.
 *
 * `csquotes`' `\textquote` is used rather than raw quotation marks because it
 * gets the marks right for the document's language — German documents want
 * „low-high“ and French wants « guillemets », and hardcoding `` '' `` produces
 * a document that is wrong in a way the author may not notice.
 */
function quotation(annotation: ZoteroAnnotation, citationKey: string): string {
  const text = escapeLatex(annotation.text.replace(/\s+/g, " ").trim());
  const cite = annotation.pageLabel
    ? `\\cite[${escapeLatex(annotation.pageLabel)}]{${citationKey}}`
    : `\\cite{${citationKey}}`;
  return `\\textquote[${cite}]{${text}}`;
}

/**
 * Escape the characters that are syntax in LaTeX.
 *
 * Highlighted text is arbitrary prose lifted out of a PDF, and prose contains
 * `%` and `&`. A stray `%` comments out the rest of the line, which breaks the
 * build in a way that looks nothing like its cause.
 */
function escapeLatex(text: string): string {
  // One pass, not two. Escaping backslashes in a second pass would also escape
  // the backslashes the first pass just introduced.
  const replacements: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
    "&": "\\&",
    "%": "\\%",
    $: "\\$",
    "#": "\\#",
    _: "\\_",
    "{": "\\{",
    "}": "\\}",
  };
  return text.replace(
    /[\\~^&%$#_{}]/g,
    (character) => replacements[character]!,
  );
}
