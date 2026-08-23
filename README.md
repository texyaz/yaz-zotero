# Zotero

Cite from your Zotero library, and quote the passages you highlighted.

A plugin for [yaz](https://github.com/texyaz/yaz).

## What it does

### Drag a source in

Drag an item out of Zotero's list and drop it into the text. yaz writes the
entry into the `.bib` the document actually loads and puts a citation at the
drop.

Drag a **highlight** and you get the passage as a quotation with its citation
attached — the page number included, where the annotation carries one. That is
the one worth having: reading happens in a PDF viewer and writing happens
somewhere else, and the passage you marked three weeks ago is exactly what you
are trying to remember when you sit down to write.

Both work whatever Zotero's **Settings → Export → Quick Copy** format is set to.
A Markdown drag carries `zotero://select` and `zotero://open-pdf` links, which
name the item outright; a citation-style drag carries only formatted text, and
then the item is found by searching the library for its title and its authors.
When neither identifies it, you are offered the source picker rather than being
told nothing happened.

### Two commands

- **Cite from Zotero** — search the library, choose an item, and get a
  `\parencite{key}` at the caret.
- **Quote a passage** — the highlights and notes you made while reading an
  attachment, listed so you can drop one into the text with its citation.

### The Citations tab

Every work the document cites, with how many times. Clicking one steps through
its occurrences — press again for the next. The tab is core; this plugin only
fills the bibliography it reads.

## Citation keys, three ways

Set under **Settings → Plugins → Zotero**.

| Scheme | What a key looks like | Why |
| --- | --- | --- |
| **Readable key with a hidden item id** | `spielbauer2020` | Reads as a key a person wrote, and carries Zotero's item id in a `note` field so the entry can still be found later |
| **The item key itself** | `5F6XQK29` | Unambiguous and stable. Zotero renames nothing, so neither does the document |
| **Better BibTeX** | `spielbauer_bki_2020` | The keys the Better BibTeX extension already generates, for a library that uses it |

The third currently falls back to a readable key: reading Better BibTeX's own
keys needs its API, which is [on the roadmap](ROADMAP.md) and not yet built.
It is listed rather than hidden because which scheme a document uses is a
decision worth making before there are two hundred citations in it.

## What ends up in the `.bib`

By default: the fields the entry type needs to print correctly, and no more.
Under the plugin's settings you can ask for more — abstracts, keywords, file
paths, the lot — because a `.bib` that carries everything is either a useful
archive or an unreadable one depending on who is looking at it.

**Refresh from Zotero** re-reads the entries the document cites and rewrites
them, so a title corrected in Zotero reaches the paper. It matches on the item
id rather than the citation key, which is why the id is worth keeping.

The project's `.bib` remains the compile-time source of truth
([ADR-0008](https://texyaz.github.io/yaz/adr/0008-zotero-integration)) — so the
document builds on a co-author's machine that has never heard of Zotero.

## When Zotero is not running

If it is installed, you are offered to start it. If it is not, you are told so
rather than being left with a search that returns nothing.

Reading the library **online**, from zotero.org, is deliberately not built yet;
it is [on the roadmap](ROADMAP.md).

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
git clone https://github.com/texyaz/yaz-zotero
cd yaz-zotero
pnpm install
pnpm check
```

To run it against a local yaz, point yaz at this directory in
**Settings → Plugins → Development plugin**, and use **Reload plugins**. No
commit, no push, no release — see
[writing a plugin](https://texyaz.github.io/yaz/plugins/writing-a-plugin).

## Roadmap

What is built, what is next, and what has been deliberately left undone — the
library on zotero.org among it: [ROADMAP.md](ROADMAP.md).

## Licence

MIT. The application is AGPL-3.0, but its plugin API is MIT and so is this, so
that anyone can copy it as a starting point without inheriting a licence they
did not choose.
