/**
 * How this plugin's settings panel looks.
 *
 * Every colour is one of the theme's tokens. yaz rejects a literal colour in
 * its own components (ADR-0010) because a user theme has to be able to restyle
 * everything, and a plugin that painted itself would be the one thing on
 * screen that ignored the theme the user chose.
 */
export const SETTINGS_STYLE = `
.yaz-zotero-settings {
  border: 1px solid var(--yaz-border);
  border-radius: var(--yaz-radius-md);
  padding: var(--yaz-space-3);
  margin: 0;
  font-family: var(--yaz-font-sans);
  color: var(--yaz-text-primary);
}
.yaz-zotero-settings legend {
  padding-inline: var(--yaz-space-2);
  font-weight: 600;
}
.yaz-zotero-note {
  margin: 0 0 var(--yaz-space-3);
  color: var(--yaz-text-muted);
  font-size: 0.9em;
}
.yaz-zotero-choice {
  display: flex;
  align-items: flex-start;
  gap: var(--yaz-space-2);
  padding-block: var(--yaz-space-2);
  cursor: pointer;
}
.yaz-zotero-choice + .yaz-zotero-choice {
  border-block-start: 1px solid var(--yaz-border);
}
.yaz-zotero-choice-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.yaz-zotero-choice-label {
  font-weight: 600;
}
.yaz-zotero-choice-detail {
  color: var(--yaz-text-muted);
  font-size: 0.9em;
}
`;
