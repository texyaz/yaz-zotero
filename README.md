# Zotero

Cite from your Zotero library, and quote the passages you highlighted.

A plugin for [yaz](https://github.com/texyaz/yaz).

## What it does

Two commands:

- **Cite from Zotero** — search the library, choose an item, and get a
  `\parencite{key}` at the caret. The entry is copied into the project's
  bibliography on the way, so the document builds on a machine that has never
  heard of Zotero.
- **Quote a passage** — the highlights and notes you made while reading an
  attachment, listed so you can drop one into the text with its citation.

The second is the one worth having. Reading happens in a PDF viewer and writing
happens somewhere else, and the passage you marked three weeks ago is the thing
you are trying to remember when you sit down to write.

## It reads a copy, and it says which

Zotero holds its library in SQLite, and SQLite does not want two writers. So
this reads a copy, and the connection status says exactly which source answered
— live API, copied database, or an exported `.bib` — because "Zotero is running
but its local API is switched off" is fixable in half a minute and invisible if
the user is only told the library is being read offline.

A citation key from a source that is not authoritative is marked as such rather
than being presented as final
([ADR-0008](https://texyaz.github.io/yaz/adr/0008-zotero-integration)).

## Capabilities

```json
"capabilities": [{ "kind": "zotero" }, { "kind": "fs-project" }]
```

Two, and both are enforced in the Rust process rather than here
([ADR-0006](https://texyaz.github.io/yaz/adr/0006-plugin-runtime-and-capabilities)).
`fs-project` is scoped to the open project and is what lets a citation reach
the project's `.bib`; it does not let this plugin read anything else on the
disk. There is no unbrokered path — which is what makes this plugin a genuine
test of the API rather than a privileged insider
([ADR-0005](https://texyaz.github.io/yaz/adr/0005-extensibility-tiers)).

## Development

```sh
git clone https://github.com/texyaz/yaz-plugin-zotero
cd yaz-plugin-zotero
pnpm install
pnpm check
```

To run it against a local yaz, point yaz at this directory in
**Settings → Plugins → Development plugin**, and use **Reload plugins**. No
commit, no push, no release — see
[writing a plugin](https://texyaz.github.io/yaz/plugins/writing-a-plugin).

## Licence

MIT. The application is AGPL-3.0, but its plugin API is MIT and so is this, so
that anyone can copy it as a starting point without inheriting a licence they
did not choose.
