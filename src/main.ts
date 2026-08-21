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
  type DroppedData,
  type PickerItem,
  type ZoteroAnnotation,
  type ZoteroItem,
} from "@yaz/api";

import { readZoteroDrop } from "./drop";
import type { ZoteroDrop } from "./drop";
import { citation, citations, quotation, unattributed } from "./latex";

/** How many library rows to request per keystroke. */
const PAGE_SIZE = 50;

/** Longest passage shown in a picker row before it is elided. */
const PREVIEW_LENGTH = 240;

/**
 * How much text it takes before looking a dropped reference up is worth trying.
 *
 * Short strings match half a library. The threshold is not about precision —
 * the single-match rule handles that — but about not sending a query that will
 * return fifty rows so we can throw them away.
 */
const MIN_MATCH_LENGTH = 12;

/** How many times to look for a Zotero that has just been started. */
const LAUNCH_ATTEMPTS = 12;

/** How long between those looks. Twelve of these is about half a minute. */
const LAUNCH_INTERVAL_MS = 2500;

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

    /*
     * Dragging out of Zotero.
     *
     * The two flavours are not two formats of the same thing: `text/plain` is
     * the formatted reference the author saw themselves dragging, and
     * `text/html` is where Zotero attaches the machine-readable version that
     * names the actual library item. Only the second can become a citation a
     * compiler will resolve, which is why both are asked for.
     */
    this.registerDropHandler({
      flavours: ["text/html", "text/plain"],
      handle: (dropped) => this.dropped(dropped),
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

    const entry = await this.app.zotero.ensureInBibliography(item.key);
    editor.insertAtCursor(
      annotation
        ? quotation(annotation.text, entry.key, annotation.pageLabel)
        : citation(entry.key),
    );

    if (!entry.isAuthoritative) {
      // ADR-0008: without Better BibTeX the key is ours, and may not match what
      // a co-author's library produces. Better said now than discovered in
      // someone else's document.
      this.app.notices.show("zotero-notice-generated-key", {
        key: entry.key,
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

  /**
   * Turn a drag out of Zotero into LaTeX, or decline it.
   *
   * Declining is a real outcome and not a failure: a drag from somewhere else
   * lands here too, and returning `null` hands it back to the editor, which
   * puts the text in as text.
   */
  private async dropped(data: DroppedData): Promise<string | null> {
    const drop = readZoteroDrop(data.flavours["text/html"] ?? "", data.text);
    switch (drop.kind) {
      case "annotation":
        return this.droppedPassage(drop);
      case "citation":
        return this.droppedSources(drop);
      default:
        return this.droppedProse(drop);
    }
  }

  /** A highlight: the passage, attributed to the work it came from. */
  private async droppedPassage(
    drop: Extract<ZoteroDrop, { kind: "annotation" }>,
  ): Promise<string | null> {
    if (!drop.text) return null;
    if (!drop.itemKey) {
      // The words are real and the source is not identified. Quoting them
      // unattributed is honest and leaves the author one thing to fill in;
      // inventing a key would leave them nothing to notice.
      this.app.notices.show("zotero-notice-drop-unresolved");
      return unattributed(drop.text);
    }
    const entry = await this.app.zotero.ensureInBibliography(drop.itemKey);
    return quotation(drop.text, entry.key, drop.pageLabel);
  }

  /** One or more sources dragged out of the library. */
  private async droppedSources(
    drop: Extract<ZoteroDrop, { kind: "citation" }>,
  ): Promise<string | null> {
    const keys: string[] = [];
    let pageLabel: string | null = null;
    for (const item of drop.items) {
      const entry = await this.app.zotero.ensureInBibliography(item.itemKey);
      keys.push(entry.key);
      pageLabel ??= item.locator;
    }
    if (keys.length === 0) return null;
    // A page reference belongs to one work. Dragging several at once is citing
    // several sources for one claim, and there is no page that means anything
    // across all of them.
    return keys.length === 1
      ? citation(keys[0]!, pageLabel)
      : citations(keys);
  }

  /**
   * A drag that carried no machine data: prose, and a single chance to place it.
   *
   * Looking the text up in the library is a guess, so it is only taken when
   * exactly one item matches. Two matches means the words do not identify a
   * work, and one wrong citation key compiles perfectly while citing something
   * the author never read.
   */
  private async droppedProse(
    drop: Extract<ZoteroDrop, { kind: "text" }>,
  ): Promise<string | null> {
    if (!drop.text) return null;

    const query = searchable(drop.text);
    if (query.length >= MIN_MATCH_LENGTH) {
      const found = await this.app.zotero.search(query, 2);
      if (found.length === 1) {
        const entry = await this.app.zotero.ensureInBibliography(found[0]!.key);
        return citation(entry.key);
      }
    }

    // Not a source we can name. Declining hands it back to the editor, which
    // inserts the words — the same thing that would have happened before any of
    // this existed.
    return null;
  }

  /**
   * Connect, and say what to do when there is nothing to connect to.
   *
   * Two situations, and they want different things said about them. Zotero
   * running means there is nothing to decide — report which source is answering
   * and stop. Zotero closed is a *choice*: start it, read the library online,
   * or carry on with the offline copy, which is a real answer and not a
   * consolation prize (it is the fast query path either way).
   */
  private async reconnect(): Promise<void> {
    await this.app.zotero.refresh();
    const status = await this.app.zotero.status();
    if (status.isRunning) {
      this.app.notices.show(status.sourceKey);
      return;
    }

    const installed = await this.app.zotero.isInstalled();
    const choice = await this.app.ui.pick<"launch" | "online" | "offline">({
      titleKey: "zotero-connect-title",
      items: [
        // Only where it can actually be done. An offer that fails is worse
        // than no offer.
        ...(installed
          ? [
              {
                value: "launch" as const,
                label: this.app.i18n.t("zotero-connect-launch"),
                description: this.app.i18n.t("zotero-connect-launch-detail"),
              },
            ]
          : []),
        {
          value: "online" as const,
          label: this.app.i18n.t("zotero-connect-online"),
          description: this.app.i18n.t("zotero-connect-online-detail"),
        },
        {
          value: "offline" as const,
          label: this.app.i18n.t("zotero-connect-offline"),
          description: this.app.i18n.t("zotero-connect-offline-detail", {
            source: this.app.i18n.t(status.sourceKey),
          }),
        },
      ],
    });

    if (choice === "launch") return this.startZotero();
    if (choice === "online") {
      // Listed because it is the other half of the choice and leaving it out
      // would suggest there is no such thing. Saying plainly that it is not
      // built beats a menu entry that quietly does nothing.
      this.app.notices.show("zotero-notice-online-later");
      return;
    }
    if (choice === "offline") this.app.notices.show(status.sourceKey);
  }

  /**
   * Start Zotero and wait a bounded while for it to answer.
   *
   * Bounded, and not a wait for the program to be *ready*: Zotero takes as long
   * as it takes and an editor that sat blocked on it would be worse than one
   * that said "started, ask again". So this checks a few times over about half
   * a minute and then stops, having said so either way.
   */
  private async startZotero(): Promise<void> {
    try {
      await this.app.zotero.launch();
    } catch {
      this.app.notices.show("zotero-notice-launch-failed");
      return;
    }
    this.app.notices.show("zotero-notice-launching");

    for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt += 1) {
      await new Promise((resume) => setTimeout(resume, LAUNCH_INTERVAL_MS));
      await this.app.zotero.refresh();
      const status = await this.app.zotero.status();
      if (status.isRunning) {
        this.app.notices.show(status.sourceKey);
        return;
      }
    }
    this.app.notices.show("zotero-notice-launch-slow");
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

/**
 * The part of a formatted reference worth searching for.
 *
 * The trailing date and the punctuation around it are the parts a citation
 * style adds; the title is the part that identifies the work. Dropping the tail
 * is what turns "DIN EN ISO 29481-1 IDM Bauwerksinformationsmodelle Handbuch
 * der Informationslieferungen, Jan. 2025." into something the library will
 * match.
 */
function searchable(text: string): string {
  return text
    .replace(/,\s*[A-Za-zÄÖÜäöü.]*\s*\d{4}\.?\s*$/, "")
    .replace(/[.,;]+\s*$/, "")
    .trim();
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
