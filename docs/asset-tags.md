# Asset tags

Tags exist so footage can be found, grouped and matched — by a person
scanning a Library, and by a tool composing a filter. A tag earns its place
only if it helps do one of those things.

## What a tag is

Users enter a label. The app infers the category for known tags: `kitchen`
belongs to places, and `Close Up`, `closeup` and `tight shot` all resolve to
editing/close-up. Other labels reuse an existing category when available or
become custom tags. No category selector is required.

Storage retains a **facet** and **canonical key** so explicit categories can
disambiguate user-defined groups. MCP callers may supply a facet, including
`custom` to deliberately keep a separate identity. Existing alias assignments
and dismissals are grouped consistently without discarding their history;
removing or restoring a tag applies to its stored aliases too.

| Facet | Holds | Examples |
| --- | --- | --- |
| `people` | Visible composition and role | solo subject, two people, crowd, interviewer, interviewee |
| `places` | Setting, plus interior/exterior and day/night | kitchen, street, studio, beach, interior, night |
| `editing` | Framing, supported movement, coverage, audio character | wide shot, close-up, establishing shot, insert, interview, dialogue, ambience |
| `custom` | Free-form user groups | Hero shot, Client approved |

Automatic tagging emits `people`, `places` and `editing` only. `custom` is the
user's; nothing automatic writes there.

## Automatic and manual

Automatic tags come from analysis the book already has: an image's structured
records ride along with the reproduction prompt, video reads its cached
analysis, audio reads its transcript, and a script reads its sluglines. Video
analysis returns structured editorial tags alongside its search description.
Older video caches contribute exact tag terms and supported setting evidence.
No extra provider call is made to produce a tag when the evidence already exists.

Manual intent always outranks analysis:

- A manual tag survives every re-analysis.
- Removing a tag **dismisses** it, so re-analysis cannot bring it
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

Still images and sparse video frames contribute visible composition, settings
and framing only. They cannot establish interview roles, camera movement or
sound. A nonempty transcript supports dialogue; multiple speakers do not prove
an interview or the number of visible people, and an empty transcript does not
prove ambience. Missing or malformed image tag records count as needing
analysis; a valid empty tag array counts as analyzed with no useful tags.

The current policy is `editorial-tags-v2`. A cached-only retag or backfill
rechecks older snapshots without provider calls and reports legacy images that
need fresh analysis.

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

Pause and cancel stop starting assets and requesting analysis. Work already
queued may finish; completed work is checkpointed without changing the saved
control state. Resume retains progress and options, while starting a new pass
resets them. Older workers cannot overwrite a replacement pass.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `edit_asset_tag` | `op: add` a manual tag, `remove` (and dismiss) a tag, or `restore` a dismissed automatic tag on one asset |
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
in a row; edits are saved in order, and a failed edit rolls back with the reason.
Background analysis and external tag edits continue refreshing the inspector.
Clicking a chip on a Library card filters by it, and changing filters restarts at the
first page.
