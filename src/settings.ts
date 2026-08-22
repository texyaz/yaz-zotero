/**
 * What this plugin remembers, and the panel that changes it.
 *
 * # Why the citation key is a setting and not a decision
 *
 * There are three defensible answers and no way to pick one for everybody:
 *
 * | Scheme | `\cite{...}` reads | Matches a co-author | Needs |
 * | --- | --- | --- | --- |
 * | `readable` | `meister2021building` | not necessarily | nothing |
 * | `item-key` | `B8IM9SU5` | yes, if they use yaz | nothing |
 * | `better-bibtex` | `meister:2021aa` | yes | Zotero + BBT running |
 *
 * A thesis written alone wants the first, because the source stays legible. A
 * paper with four authors sharing a Zotero group wants the third, because the
 * keys have to agree. The second is for anyone who would rather never think
 * about naming again.
 *
 * Whichever is chosen, the entry records which Zotero item it is — so re-citing
 * a source finds the entry that is already there by *identity*, and renaming a
 * key by hand does not produce a duplicate.
 */

import type { App, BibliographyFields, CitationKeyScheme } from "@yaz/api";

/** Everything this plugin stores. */
export interface ZoteroSettings {
  keyScheme: CitationKeyScheme;
  fields: BibliographyFields;
}

/** What a fresh installation behaves as. */
export const DEFAULT_SETTINGS: ZoteroSettings = {
  // Legible in the source, and needs nothing installed. The other two are
  // improvements for people who know they want them.
  keyScheme: "readable",
  fields: {
    // Written by default, because biber ignores a field the style does not
    // print: too much costs a longer file, too little costs a reference that
    // loses its publisher when the author changes style.
    publication: true,
    location: true,
    identifiers: true,
    // The exception. An abstract is a paragraph per entry, and a `.bib` nobody
    // can read is a `.bib` nobody will correct.
    summary: false,
  },
};

/** The field groups, and the message keys naming them. */
const FIELD_GROUPS: readonly (keyof BibliographyFields)[] = [
  "publication",
  "location",
  "identifiers",
  "summary",
];

/** The schemes, in the order the panel offers them. */
const SCHEMES: readonly CitationKeyScheme[] = [
  "readable",
  "item-key",
  "better-bibtex",
];

/**
 * Read the settings, filling in anything a previous version did not store.
 *
 * Merged rather than replaced, so a setting added in a later version arrives at
 * its default for somebody who has already been here — the same rule the
 * application's own settings follow.
 */
export async function readSettings(app: App): Promise<ZoteroSettings> {
  const stored = await app.settings.get<Partial<ZoteroSettings>>();
  const scheme = stored?.keyScheme;
  return {
    keyScheme: SCHEMES.includes(scheme as CitationKeyScheme)
      ? (scheme as CitationKeyScheme)
      : DEFAULT_SETTINGS.keyScheme,
    fields: { ...DEFAULT_SETTINGS.fields, ...(stored?.fields ?? {}) },
  };
}

/**
 * Draw the settings panel into `container`.
 *
 * Plain DOM, because that is the whole contract: the plugin is handed an
 * element and the shell's framework stays the shell's business (ADR-0005).
 */
export function renderSettings(app: App, container: HTMLElement): void {
  const draw = (current: ZoteroSettings): void => {
    container.replaceChildren();

    const box = document.createElement("fieldset");
    box.className = "yaz-zotero-settings";

    const legend = document.createElement("legend");
    legend.textContent = app.i18n.t("zotero-settings-key-scheme");
    box.append(legend);

    const note = document.createElement("p");
    note.className = "yaz-zotero-note";
    note.textContent = app.i18n.t("zotero-settings-key-scheme-detail");
    box.append(note);

    for (const scheme of SCHEMES) {
      const row = document.createElement("label");
      row.className = "yaz-zotero-choice";

      const radio = document.createElement("input");
      radio.type = "radio";
      // One group name, so the browser gives the three of them radio
      // behaviour rather than three independent switches.
      radio.name = "yaz-zotero-key-scheme";
      radio.value = scheme;
      radio.checked = current.keyScheme === scheme;
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        const next: ZoteroSettings = { ...current, keyScheme: scheme };
        void app.settings.set(next).then(() => {
          // Redrawn from what was stored rather than from what was clicked, so
          // the panel shows what is actually saved.
          draw(next);
          app.notices.show("zotero-settings-saved");
        });
      });

      const words = document.createElement("span");
      words.className = "yaz-zotero-choice-text";

      const name = document.createElement("span");
      name.className = "yaz-zotero-choice-label";
      name.textContent = app.i18n.t(`zotero-key-scheme-${scheme}`);

      const detail = document.createElement("span");
      detail.className = "yaz-zotero-choice-detail";
      detail.textContent = app.i18n.t(`zotero-key-scheme-${scheme}-detail`);

      words.append(name, detail);
      row.append(radio, words);
      box.append(row);
    }

    container.append(box);

    const written = document.createElement("fieldset");
    written.className = "yaz-zotero-settings";

    const heading = document.createElement("legend");
    heading.textContent = app.i18n.t("zotero-settings-fields");
    written.append(heading);

    const why = document.createElement("p");
    why.className = "yaz-zotero-note";
    why.textContent = app.i18n.t("zotero-settings-fields-detail");
    written.append(why);

    for (const group of FIELD_GROUPS) {
      const row = document.createElement("label");
      row.className = "yaz-zotero-choice";

      const box_ = document.createElement("input");
      box_.type = "checkbox";
      box_.checked = current.fields[group];
      box_.addEventListener("change", () => {
        const next: ZoteroSettings = {
          ...current,
          fields: { ...current.fields, [group]: box_.checked },
        };
        void app.settings.set(next).then(() => {
          draw(next);
          app.notices.show("zotero-settings-saved");
        });
      });

      const words = document.createElement("span");
      words.className = "yaz-zotero-choice-text";

      const name = document.createElement("span");
      name.className = "yaz-zotero-choice-label";
      name.textContent = app.i18n.t(`zotero-fields-${group}`);

      const detail = document.createElement("span");
      detail.className = "yaz-zotero-choice-detail";
      detail.textContent = app.i18n.t(`zotero-fields-${group}-detail`);

      words.append(name, detail);
      row.append(box_, words);
      written.append(row);
    }

    container.append(written);
  };

  void readSettings(app).then(draw);
}
