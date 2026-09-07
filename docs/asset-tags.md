# Asset tags

Tags exist so footage can be found, grouped and matched — by a person
scanning a Library, and by a tool composing a filter. A tag earns its place
only if it helps do one of those things.

## What a tag is

Every tag has a **facet**, a **canonical key** and a **display label**.
Identity is the pair `(facet, key)`, never the label, so `people/handheld` and
`editing/handheld` stay distinct while `Close Up`, `closeup` and `tight shot`
all resolve to one identity.

| Facet | Holds | Examples |
| --- | --- | --- |
| `people` | Visible composition and role | solo subject, two people, crowd, interviewer, interviewee |
| `places` | Setting, plus interior/exterior and day/night | kitchen, street, studio, beach, interior, night |
| `editing` | Framing, supported movement, coverage, audio character | wide shot, close-up, establishing shot, insert, interview, dialogue, ambience |
| `custom` | Anything a person types | Hero shot, Client approved |

Automatic tagging emits `people`, `places` and `editing` only. `custom` is the
user's; nothing automatic writes there.

## Automatic and manual

Automatic tags come from analysis the book already has: an image's structured
records ride along with the reproduction prompt, video reads its cached
analysis, audio reads its transcript, and a script reads its sluglines. No
extra provider call is made to produce a tag when the evidence already exists.

Manual intent always outranks analysis:

- A manual tag survives every re-analysis.
- Removing an automatic tag **dismisses** it, so re-analysis cannot bring it
  back. Dismissed tags stay listed with a restore control.
- Automatic tags are fenced to the content they described. Replace an asset's
  media and its automatic tags retire immediately, because they describe bytes
  the asset no longer has. Manual tags stay.

What automatic tagging will not claim: how good or moody footage looks, an
inventory of objects that happened to be in shot, a person named in a
transcript but not identified on screen, a city guessed from scenery, or
camera movement that evenly spaced frames cannot establish. The ceiling is 12
tags per analysis and it is a ceiling, never a quota — weak evidence produces
fewer tags, or none.

## Costs

Adopting analysis a book already paid for is free. Asking a provider to
analyze media that was never analyzed is not, so the two are separated:

- **New assets** are tagged automatically as they become ready, and may
  request the analysis they need. Turn either behaviour off per book with
  `configure_asset_tagging`.
- **An existing library** is backfilled by an explicit action. The default
  pass reads caches only and reports how many assets *would* need analysis;
  pass `allow_analysis` once you have seen that number and decided.

Manual tagging, filtering and search work whatever these settings say, and
whether or not a provider key is configured.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `add_asset_tag` | Add a manual tag to one asset |
| `remove_asset_tag` | Remove a tag; an automatic one becomes a dismissal |
| `restore_asset_tag` | Restore a dismissed automatic tag |
| `suggest_asset_tags` | Tags in use with per-asset counts, for autocomplete and discovery |
| `retag_asset` | Re-run tagging for one asset (`force`, `cached_only`) |
| `backfill_asset_tags` | `start`, `resume`, `pause`, `cancel`, `status` for a whole book |
| `configure_asset_tagging` | Read or change automatic tagging for a book |

Asset payloads from `list_assets`, `search_library_assets` and the refresh
paths carry a `tags` object: `effective`, `manual`, `automatic`, `dismissed`,
the `analysis` that produced the automatic set, and a `fingerprint` that
changes only when the effective set or a dismissal does.

### Filtering

`list_assets` and `search_library_assets` take `tags_all` and `tags_any`.
Terms are `{ facet?, label }`; a bare label matches the identity in any facet.
Matching is exact against the effective set — a dismissed tag never matches,
and neither does a transcript that merely mentions the word, which is what
semantic search is for. Filters apply before paging and before top-k, so
totals and `tag_facets` counts describe the filtered result.

```json
{
  "book_id": "…",
  "kinds": ["video"],
  "tags_all": [
    { "facet": "places", "label": "studio" },
    { "facet": "editing", "label": "close-up" }
  ]
}
```

## In the app

Tags appear as chips on asset cards and as an editor in the cell inspector.
An automatic tag is drawn with a dashed edge and reads as "from analysis" to a
screen reader; a manual one reads as "added by you". Neither shows a model
name or a confidence score.

Typing a tag applies it immediately and keeps focus, so several can be entered
in a row; if the write fails the chip rolls back with the reason. Clicking a
chip on a Library card filters by it, and changing filters restarts at the
first page.
