# Own-facts file (draft)

How a streamer's own facts are stored, so the features after it have one clean place to read
from. Draft (issue #193). Nothing in the app reads it yet, and nothing built on it goes live before a
usability check and a GUI check with real streamers.

- `fact-record.schema.json`: the JSON Schema.
- `examples/facts.example.bffacts`: an example file. A `.bffacts` file is JSON.
- `backend/src/fact-record.ts`: the same rules in code (normalize, fingerprint, validate, lines to
  records and back), tested against the example.

**File names:** `.bf` plus what the file holds, so other kinds can follow without clashing
(`.bffacts` now, perhaps `.bfstyle` for a Style later).

## What is in v1

Only what normalizing today's two lists needs.

- **A permanent random id** (`fct_` and 26 base32 characters), never built from the text.
- **Text normalized on save:** NFC, single spaces, straight quotes, no control characters, at most 300 characters.
- **`kind`:** `yours` or `joke`.
- **`scope`:** `all`, `originals`, a `tag` (the `[Tag]` before a line today), or a `song`.
- **`expires`:** a date; the fact shows through that day.
- **`created` and `modified`.**
- **`fingerprint`:** finds likely duplicates, always confirmed by comparing the text.
- **Unknown fields are kept** when a record is read and written again, so a later version can add
  a field without a migration.
- **Today's lines convert both ways** (`[Tag] text` and a `tag` scope), so the settings text box
  stays the editing surface.

## Left out on purpose

Anything beyond this is added, as new fields on top of v1, only when a feature that needs it is being built.
