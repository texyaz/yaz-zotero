# yaz-zotero — roadmap

What this plugin does today, what it is going to do, and — the part worth
writing down — what has been deliberately left undone and why.

## Today

**Local Zotero, and only local Zotero.** Everything below reads the library on
this machine: the copied `zotero.sqlite` for queries, and Zotero's own local API
to answer the one question the copy cannot, which is whether the copy is
current.

| | |
| --- | --- |
| Cite a source | `Mod+Shift+C`, picker over the whole library |
| Quote a marked passage | `Mod+Shift+Q`, picker over the highlights in one source |
| Drag a source in | `\cite{key}`, and the entry copied into the project `.bib` |
| Drag a highlight in | `\textquote[\cite[8]{key}]{…}` |
| Connect | Reports which source is answering, and offers to start Zotero |

Dragging reads the **machine-readable** half of what Zotero puts on the drag —
the `data-citation` and `data-annotation` blobs in the `text/html` flavour —
rather than the formatted prose in `text/plain`. See `src/drop.ts` for why, and
for why we do not ask anybody to change their Zotero settings to make this work.

## Next

- **Better BibTeX (tier 1).** Citation keys that Zotero owns, so a key here
  matches the key in a co-author's document. Without it the keys are ours and
  the interface says so, which is the honest version of the same thing but not
  the good version.
- **Watched exported `.bib` (tier 3).** For a library that is exported rather
  than installed, and for co-authors who keep one in the repository.
- **Notes.** A Zotero note is the reader's own words, so it is not offered as a
  quotation. Pulling one in as *the author's own text* is a different feature
  and a real one.

## Deferred: the library on zotero.org

**Reading the library over the Zotero Web API is planned and not built.** The
connect dialog offers it as a choice and then says so, rather than leaving it
out — because a citation manager that only works when a desktop application is
installed is a real limitation, and hiding the limitation does not remove it.

What it would take, and why none of it is free:

- **An API key.** The Web API needs a personal key from zotero.org, which means
  storing a credential — the first secret this application would hold. That is
  a design question (where it lives, what happens on another machine, how it is
  revoked) before it is an implementation one.
- **A `net` capability.** The plugin declares `zotero` and `fs-project` today
  and reaches nothing outside this machine. Talking to zotero.org means
  declaring the host, and a user installing the plugin should be told that is
  what changed.
- **Different performance.** The local path is fast because it queries a copy of
  a database: sixteen milliseconds across every library. A remote path is a
  request per keystroke over the network, so the picker needs debouncing and a
  cache that the local path does not.
- **Annotations may not be there.** Highlights live in the attachment, and an
  attachment stored only on a local disk is not in the online library. A quote
  picker that silently found nothing would look broken rather than empty.

None of that is hard. It is just a second integration rather than a flag on the
first one, and doing it badly — a slow picker, a silently empty highlight list,
a credential in the wrong place — would be worse than not having it.

## Not planned

- **Changing Zotero's own settings.** Zotero's Quick Copy format is one setting
  shared by every program its user drags into. Rewriting it, whether by asking
  or through an API, would change what they get in Word and in their notes for
  the sake of what they get here. The machine-readable data we read is present
  whatever that setting says, so nobody has to choose — and that is the point.
- **Writing to the Zotero database.** It is read through a copy, and the
  original is never opened. A citation tool that could corrupt somebody's
  library is not a trade worth making for any feature.
