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

import { agentTools } from "./agent";
import { readZoteroDrop, readZoteroUris } from "./drop";
import { readSettings, renderSettings } from "./settings";
import type { CommentHandling } from "./settings";
import { SETTINGS_STYLE } from "./style";
import type { ZoteroDrop } from "./drop";
import {
  citation,
  annotationMarkAt,
  citationKeyAt,
  citations,
  escapeLatex,
  figureFromSource,
  quotation,
  unattributed,
} from "./latex";

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

/**
 * The `.bib` a document says it loads, or null where it says nothing.
 *
 * This is not a nicety. `ensureInBibliography` defaults to `references.bib`,
 * and a document whose preamble says `\\addbibresource{BIMwissT.bib}` then gets its
 * entries written to a file LaTeX never reads — the key is on disk, the
 * citation stays unresolved, and nothing about it looks wrong. So the
 * declaration is read from the buffer and it decides where the entry goes.
 *
 * Only the first: biblatex takes several resources, and a new entry has to go
 * in one of them. The first is the one the author wrote first.
 */
export function declaredBibliography(text: string): string | undefined {
  const resource = /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(text);
  const classic = /\\bibliography\s*\{([^}]*)\}/.exec(text);
  const name = (resource?.[1] ?? classic?.[1]?.split(",")[0] ?? "").trim();
  if (!name) return undefined;
  // `\bibliography{refs}` omits the extension; `\addbibresource{refs.bib}` does not.
  return /\.bib$/i.test(name) ? name : `${name}.bib`;
}

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
      // `Files` as well as the text flavours: an image annotation dragged out
      // of Zotero can be a picture and nothing else, and a handler that only
      // asked about text never heard about it.
      flavours: ["text/html", "text/plain", "text/uri-list", "Files"],
      handle: (dropped) => this.dropped(dropped),
    });

    this.addSettingsTab({
      titleKey: "zotero-settings-title",
      render: (container) => renderSettings(this.app, container),
    });
    styleOnce();

    this.addCommand({
      id: "reveal",
      nameKey: "zotero-command-reveal",
      descriptionKey: "zotero-command-reveal-description",
      defaultHotkey: "Mod+Shift+O",
      isAvailable: () => this.app.editor !== null,
      callback: () => this.reveal(),
    });

    // The same jump, as its own button: only ever the highlight behind a
    // marked sentence (ADR-0030). Separate so the white-box step is visible
    // under Connections, and reachable when a browser in between (noVNC)
    // swallows the shortcut.
    this.addCommand({
      id: "reveal-highlight",
      nameKey: "zotero-command-reveal-highlight",
      descriptionKey: "zotero-command-reveal-highlight-description",
      isAvailable: () => this.app.editor !== null,
      callback: () => this.reveal(true),
    });

    // Right-click on a work in the Citations tab (ADR-0032). The tab is
    // yaz's; showing the work in Zotero is this plugin's to offer.
    this.registerCitationAction({
      id: "show-in-zotero",
      labelKey: "zotero-citation-show",
      isAvailable: async () => (await this.app.zotero.status()).kind !== "none",
      run: async (key) => {
        if (!(await this.app.zotero.reveal(key))) {
          this.app.notices.show("zotero-notice-citation-not-in-library", { key });
        }
      },
    });

    // What an AI agent may do through yaz's MCP server (ADR-0031): find
    // sources and highlights, and write only as \ai[KEY]{…}.
    for (const tool of agentTools({
      app: this.app,
      citationKey: (itemKey) => this.citationKey(itemKey),
    })) {
      this.registerTool(tool);
    }

    this.addCommand({
      id: "refresh-bibliography",
      nameKey: "zotero-command-refresh",
      descriptionKey: "zotero-command-refresh-description",
      isAvailable: () => this.app.project !== null,
      callback: () => this.refreshBibliography(),
    });

    this.addCommand({
      id: "reconnect",
      nameKey: "zotero-command-reconnect",
      descriptionKey: "zotero-command-reconnect-description",
      callback: () => this.reconnect(),
    });
  }

  /**
   * Show what the cursor is on in Zotero, as precisely as the text allows.
   *
   * Inside a white-box marker, `\ai[KEY]{…}` or `\proofed[KEY]{…}`
   * (ADR-0030), that is the highlight itself: the PDF opens at the passage the
   * sentence rests on. With several keys, the one under the cursor, or else the
   * one in the source whose `\cite` the cursor is on. Elsewhere it is the
   * source of the citation under the cursor, as before.
   *
   * Which item or annotation, and which library it is in, is the Rust side's
   * question to answer; this only says which keys the cursor is on.
   */
  private async reveal(onlyHighlight = false): Promise<void> {
    const editor = this.app.editor;
    if (!editor) {
      this.app.notices.show("zotero-notice-no-editor");
      return;
    }
    const text = editor.getText();
    const offset = editor.getSelection().from;
    const mark = annotationMarkAt(text, offset);
    const key = citationKeyAt(text, offset);
    if (onlyHighlight && !(mark && mark.keys.length > 0)) {
      this.app.notices.show("zotero-notice-no-highlight-here");
      return;
    }
    try {
      if (mark && mark.keys.length > 0) {
        const keys = mark.keyAtCursor ? [mark.keyAtCursor] : mark.keys;
        if (await this.app.zotero.revealAnnotation(keys, key)) return;
        if (!key || onlyHighlight) {
          this.app.notices.show("zotero-notice-highlight-not-in-library", {
            key: keys.join(", "),
          });
          return;
        }
        // The sentence names a highlight the copy does not have yet; the
        // source is the next best thing, and the notice says why.
        this.app.notices.show("zotero-notice-highlight-not-in-library", {
          key: keys.join(", "),
        });
      }
      if (!key) {
        this.app.notices.show("zotero-notice-no-citation-here");
        return;
      }
      if (!(await this.app.zotero.reveal(key))) {
        this.app.notices.show("zotero-notice-citation-not-in-library", { key });
      }
    } catch (error) {
      this.app.notices.show("zotero-notice-reveal-failed");
      console.warn("[yaz] showing a citation in Zotero failed", error);
    }
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

    const settings = await readSettings(this.app);
    const entry = await this.app.zotero.ensureInBibliography(
      item.key,
      declaredBibliography(editor.getText()),
      settings.keyScheme,
      settings.fields,
    );
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

  /**
   * The source picker.
   *
   * `seed` is what a failed drop was trying to identify. The picker filters on
   * it, so a drag that carried no machine data becomes one click rather than a
   * paragraph of prose the author has to notice is not a citation.
   */
  private pickItem(seed?: string): Promise<ZoteroItem | null> {
    return this.app.ui.pick<ZoteroItem>({
      titleKey: "zotero-picker-source-title",
      placeholderKey: "zotero-picker-source-placeholder",
      emptyKey: "zotero-picker-source-empty",
      ...(seed ? { query: seed } : {}),
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

  /** The `.bib` the open document loads, for the drop paths. */
  private declaredBibliography(): string | undefined {
    const text = this.app.editor?.getText();
    return text ? declaredBibliography(text) : undefined;
  }

  /**
   * Turn a drag out of Zotero into LaTeX, or decline it.
   *
   * Declining is a real outcome and not a failure: a drag from somewhere else
   * lands here too, and returning `null` hands it back to the editor, which
   * puts the text in as text.
   */
  private async dropped(data: DroppedData): Promise<string | null> {
    let drop = readZoteroDrop(data.flavours["text/html"] ?? "", data.text);

    // One more place a link can be. Some drags put the `zotero://` URI in
    // `text/uri-list` and nowhere else, and a drop that landed as prose when
    // the item was named right there would be the bug this whole path exists
    // to avoid.
    if (drop.kind === "text") {
      drop = readZoteroUris(data.flavours["text/uri-list"] ?? "") ?? drop;
    }

    /*
     * A picture beats everything else the drag carried.
     *
     * An image annotation marks a *region*, not a passage: there are no words
     * to quote, and what the reader dragged is the picture. Whether the drag
     * also carried a citation only decides whether the figure can name its
     * source — not whether there is a figure.
     *
     * This is checked before the kind, because the kinds are about *text*: an
     * image annotation whose drag carried no `zotero://` link reads as prose,
     * and prose with no words in it used to end at the source picker with
     * nothing to show for it.
     */
    const picture = data.images[0];
    if (picture) return this.droppedRegion(drop, picture);

    switch (drop.kind) {
      case "annotation":
        return this.droppedPassage(drop);
      case "citation":
        return this.droppedSources(drop);
      default:
        return this.droppedProse(drop, data.flavours["text/html"] ?? "");
    }
  }

  /**
   * A dragged picture, in a figure that cites where it came from.
   *
   * The picture goes into the project through yaz rather than being written
   * here, because where a project keeps its pictures is a per-project setting
   * and the naming has to avoid what is already there — neither of which is
   * this plugin's to decide.
   *
   * When the drag did not say which work it came from, the source picker is
   * offered rather than the figure being left unattributed. That is the same
   * courtesy a dropped reference gets, and it is what somebody dragging a
   * figure out of a paper they are citing plainly wants.
   */
  private async droppedRegion(
    drop: ZoteroDrop,
    image: { type: string; bytes: Uint8Array },
  ): Promise<string | null> {
    const path = await this.app.images.save(image.bytes, image.type);
    // `null` means there was nowhere to put it, and yaz has already said so.
    // Inserting a figure pointing at a file that is not there would be worse
    // than the drop doing nothing.
    if (!path) return null;

    const marked = drop.kind === "annotation" ? drop : null;
    const itemKey =
      marked?.itemKey ??
      (drop.kind === "citation" ? (drop.items[0]?.itemKey ?? null) : null);

    if (!itemKey) {
      const picked = await this.pickItem();
      // A dismissed picker still leaves the picture worth having: it is in the
      // project either way, and a figure with an empty citation is one thing
      // to fill in rather than a paste that did nothing.
      if (!picked) {
        return figureFromSource(path, "", marked?.pageLabel ?? null);
      }
      return figureFromSource(
        path,
        await this.citationKey(picked.key),
        marked?.pageLabel ?? null,
      );
    }

    return figureFromSource(
      path,
      await this.citationKey(itemKey),
      marked?.pageLabel ?? null,
    );
  }

  /** The key an item is cited by, putting it in the bibliography on the way. */
  private async citationKey(itemKey: string): Promise<string> {
    const settings = await readSettings(this.app);
    const entry = await this.app.zotero.ensureInBibliography(
      itemKey,
      this.declaredBibliography(),
      settings.keyScheme,
      settings.fields,
    );
    return entry.key;
  }

  /** A highlight: the passage, attributed to the work it came from. */
  private async droppedPassage(
    drop: Extract<ZoteroDrop, { kind: "annotation" }>,
  ): Promise<string | null> {
    if (!drop.text) return null;
    const settings = await readSettings(this.app);

    if (!drop.itemKey) {
      // The words are real and the source is not identified. Quoting them
      // unattributed is honest and leaves the author one thing to fill in;
      // inventing a key would leave them nothing to notice.
      this.app.notices.show("zotero-notice-drop-unresolved");
      return withComment(
        unattributed(drop.text),
        drop.comment,
        settings.comments,
      );
    }

    const entry = await this.app.zotero.ensureInBibliography(
      drop.itemKey,
      this.declaredBibliography(),
      settings.keyScheme,
      settings.fields,
    );
    return withComment(
      quotation(drop.text, entry.key, drop.pageLabel),
      drop.comment,
      settings.comments,
    );
  }

  /** One or more sources dragged out of the library. */
  private async droppedSources(
    drop: Extract<ZoteroDrop, { kind: "citation" }>,
  ): Promise<string | null> {
    const keys: string[] = [];
    let pageLabel: string | null = null;
    // Read once: every entry goes in the same file, and asking the editor per
    // item would re-read the whole buffer for each one.
    const bib = this.declaredBibliography();
    const settings = await readSettings(this.app);
    for (const item of drop.items) {
      const entry = await this.app.zotero.ensureInBibliography(
        item.itemKey,
        bib,
        settings.keyScheme,
        settings.fields,
      );
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
    html: string,
  ): Promise<string | null> {
    if (!drop.text) return null;

    /*
     * Try the narrow queries before the wide one.
     *
     * One match is an answer; two are a coincidence, and a wrong citation key
     * compiles perfectly while citing something the author never read. So a
     * query that finds several does not decide anything — it seeds the picker,
     * where a person decides.
     */
    let seed = "";
    for (const query of searchQueries(drop.text, html)) {
      const found = await this.app.zotero.search(query, 2);
      if (found.length === 1) return this.cited(found[0]!.key);
      // Remember the first query that found *anything*, so the picker opens
      // somewhere useful rather than on a filter matching nothing.
      if (found.length > 1 && !seed) seed = query;
    }

    /*
     * Ask.
     *
     * Seeded only where a query actually matched something. Opening the picker
     * filtered by a string that matches nothing shows an empty list and reads
     * as "your library does not have this" — which is exactly what a dropped
     * book reported, while the book was sitting in the library.
     */
    const picked = await this.pickItem(seed || undefined);
    return picked ? this.cited(picked.key) : null;
  }

  /** Put an item in the project's bibliography and return the LaTeX to cite it. */
  private async cited(itemKey: string): Promise<string> {
    const settings = await readSettings(this.app);
    const entry = await this.app.zotero.ensureInBibliography(
      itemKey,
      this.declaredBibliography(),
      settings.keyScheme,
      settings.fields,
    );
    return citation(entry.key);
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
  /**
   * Rewrite every entry this wrote, from what Zotero says now.
   *
   * Asked for rather than automatic. It rewrites a file the author may have
   * edited by hand, and doing that in the background is how somebody loses a
   * correction they made and never mentioned.
   */
  private async refreshBibliography(): Promise<void> {
    const editor = this.app.editor;
    if (!editor) {
      this.app.notices.show("zotero-notice-no-editor");
      return;
    }
    try {
      const settings = await readSettings(this.app);
      const outcome = await this.app.zotero.refreshBibliography(
        declaredBibliography(editor.getText()),
        settings.fields,
      );
      if (outcome.missing.length > 0) {
        // Named rather than counted: a reference whose item has gone from the
        // library is one the author has to decide about, and they cannot
        // decide about a number.
        this.app.notices.show("zotero-notice-refresh-missing", {
          count: outcome.updated,
          keys: outcome.missing.join(", "),
        });
      } else {
        this.app.notices.show("zotero-notice-refreshed", {
          count: outcome.updated,
        });
      }
    } catch (error) {
      this.app.notices.show("zotero-notice-refresh-failed");
      console.warn("[yaz] refreshing the bibliography failed", error);
    }
  }

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

/**
 * The settings panel's own styling, added once.
 *
 * A stylesheet rather than inline styles so the colours are the theme's tokens:
 * yaz forbids a literal colour in its own components (ADR-0010), and a plugin
 * that painted itself would be the one thing on screen ignoring the theme the
 * user chose.
 */
function styleOnce(): void {
  const id = "yaz-zotero-style";
  if (document.getElementById(id)) return;
  const sheet = document.createElement("style");
  sheet.id = id;
  sheet.textContent = SETTINGS_STYLE;
  document.head.append(sheet);
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
 * Queries to try for a reference that carries no link, best first.
 *
 * The whole formatted string is the *worst* query and was the only one tried,
 * which is why dropping an ordinary book found nothing: Zotero matches a title
 * or a creator, and
 *
 * > H. Spielbauer, K.-P. Ruland, and Beirat Baukosteninformationszentrum, BKI
 * > Baukosten 2020 Neubau Statistische Kostenkennwerte für Gebäude, Stuttgart
 *
 * is neither — it is a style's concatenation of both, and nothing in the
 * library is called that. A standard happens to work only because its title is
 * nearly the whole entry.
 *
 * So the title is looked for. Two ways, in order of how reliable they are:
 *
 * 1. **What the style italicised.** Every style that italicises anything
 *    italicises the title, and that is a fact about the markup rather than a
 *    guess about the prose.
 * 2. **The longest comma-separated part.** Authors are short and places are
 *    shorter; the title is almost always the longest thing between two commas.
 *
 * The whole string stays on the list last, because for a standard it is right.
 */
export function searchQueries(text: string, html = ""): string[] {
  const queries: string[] = [];
  const add = (candidate: string): void => {
    const cleaned = candidate.replace(/\s+/g, " ").trim();
    if (cleaned.length >= MIN_MATCH_LENGTH && !queries.includes(cleaned)) {
      queries.push(cleaned);
    }
  };

  if (html) {
    try {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      for (const italic of parsed.querySelectorAll("i, em, cite")) {
        add(italic.textContent ?? "");
      }
    } catch {
      // Unparseable markup is one fewer candidate, not a failure.
    }
  }

  const whole = searchable(text);
  const parts = [...whole.split(",")].sort(
    (left, right) => right.trim().length - left.trim().length,
  );
  if (parts.length > 1) add(parts[0] ?? "");
  add(whole);

  return queries;
}

/**
 * The quotation, and the reader's note on it where they want one.
 *
 * Never inside the quotation, whichever way this goes: the note is the
 * reader's words and the passage is the source's, and a quotation that
 * silently contained somebody's own note would be a misattribution the author
 * would have to spot themselves.
 */
function withComment(
  latex: string,
  comment: string,
  handling: CommentHandling,
): string {
  const note = comment.replace(/\s+/g, " ").trim();
  if (!note || handling === "ignore") return latex;
  return handling === "comment"
    ? // A LaTeX comment: on screen while writing, never printed, and gone the
      // moment it is deleted.
      `${latex}\n% ${note}`
    : // Text to write from, which will print if it is left there. That is the
      // point of the setting and also its risk, which is why it is not default.
      `${latex} ${escapeLatex(note)}`;
}

/** Strip what a citation style added, leaving what identifies the work. */
export function searchable(text: string): string {
  return (
    text
      // The number a numeric style puts in front: `[1] DIN EN ISO 29481-1 …`.
      .replace(/^\s*\[\d+\]\s*/, "")
      // An author-date style's leading marker, for the same reason.
      .replace(/^\s*\(\d+\)\s*/, "")
      // The date a style appends: `, Jan. 2025.`
      .replace(/,\s*[A-Za-zÄÖÜäöü.]*\s*\d{4}\.?\s*$/, "")
      .replace(/[.,;]+\s*$/, "")
      .trim()
  );
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
