# How it works

This is for anyone changing the code. It explains how a song becomes fact
bubbles, and why the less obvious parts are the way they are. Each of those
decisions came from something going wrong on a live stream, so please read
the relevant section before changing it.

## Words used here

| Term | Meaning |
|---|---|
| **Queue entry** | One song in the StreamerSongList queue, with its title, artist field, play count, notes and requester. |
| **Grounding** | Finding the song's Wikipedia article and pulling out the useful text. |
| **Reference** | That article text, handed to the AI as its only source. |
| **Screening** | Checking each caption the AI wrote against the reference, and dropping those it doesn't support. |
| **Topic pack** | A streamer's own file of facts, in `topics/`. Used when there's no reference. The ones shipped are examples, not maintained content. |
| **Entry facts** | Facts built from the queue entry itself: "played 12 times", "requested by X". |

## The pieces

```
StreamerSongList ──(live events + a check every 15 s)──► Server ──WebSocket──► Overlay in OBS
                                                           │
                                          find article → AI rewrites → screen captions
```

| File | Job |
|---|---|
| `backend/src/songlist-client.ts` | Reads the queue from StreamerSongList and works out what's playing. |
| `backend/src/centrifugo-client.ts` | Listens for StreamerSongList's live "the queue changed" events. |
| `backend/src/song-source.ts` | What the server needs from a song source. StreamerSongList is the default; `SONG_SOURCE=streamelements` swaps in the next two files. |
| `backend/src/streamelements-client.ts` | Reads StreamElements' song request player and works out what's playing. |
| `backend/src/astro-client.ts` | Listens for StreamElements' live song request events. |
| `backend/src/youtube-title.ts` | Reads a song title and artist out of a YouTube video title, for StreamElements. |
| `backend/src/fact-generator.ts` | Decides how to handle each song, talks to the AI, caches results. |
| `backend/src/fact-verifier.ts` | Finds the right Wikipedia article and screens the AI's captions. |
| `backend/src/stat-facts.ts` | Builds entry facts. |
| `backend/src/topic.ts` | Loads the topic packs named in `TOPIC`. |
| `backend/src/server.ts` | Sends songs and facts to the overlay; reports status at `/health`. |
| `frontend/obs/` | The overlay page itself: plain HTML, CSS and JavaScript with no build step. |

## The life of one song

1. **Find what's playing.** The queue has a "now playing" slot; if the
   streamer doesn't use it, the top of the queue is used instead.
2. **Tell the overlay.** It shows the NOW PLAYING banner right away, before
   any facts exist.
3. **Handle the special cases.** A Live Learn (a request that isn't on the
   song list) gets a banner and no facts. The streamer's own composition gets
   entry facts, with no Wikipedia lookup, since there's no article.
4. **Ground.** Search Wikipedia for the game or work, reject results that
   aren't really about it, and pull out the music-related sections first.
5. **Write.** The AI rewrites details from the reference as short captions,
   following strict rules at a low temperature.
6. **Screen.** Each caption is compared with the reference, word for word:
   names, years, consoles, award and sales claims, commentary about the
   source, length, and near-repeats.
7. **No article? Try Wikidata.** When no Wikipedia article matches, the song
   is looked up on Wikidata. Its item must have the song's title as its label
   and a description naming the artist or game ("2021 single by Lil Nas X"),
   so a same-named song by someone else never matches. Each statement
   (release year, composers, lyricists, producers, album, awards, charts)
   fills a fixed sentence. No AI is involved, so nothing needs screening.
   Wikidata's structured data is public domain (CC0). If Wikidata has
   nothing, MusicBrainz (core data CC0, at most one request a second) gives a
   performer's song its first year and album. For a game's track it only names
   a composer credited on several releases naming the game, because fan covers
   crowd the results and are even tagged "Soundtrack".
8. **Fall back if needed.** No reference, a failed AI call, or nothing that
   passed screening all lead to the same place: entry facts plus the
   streamer's custom facts, or nothing when they have none. The AI is never
   asked to write without a reference.
9. **Send.** The overlay shows one bubble every `FACT_INTERVAL_SECONDS`,
   counting from when the facts arrive. If the song has already changed by
   then, it throws the batch away.

Facts are kept in memory for the rest of the session, so a repeated song is
instant; nothing generated is ever written to disk. Several requests for the
same song at once (two overlays, or one reconnecting mid-song) share a single
generation. Songs that fell back are retried after ten minutes, and the
streamer's own compositions are rebuilt every time so the play count and
requester stay current.

## Why it works this way

### Why not have a second AI check the first one's work?

It was tried. Asking the same small model to grade its own captions made
everything slower and threw out good facts at random. Instead, the prompt
frames the job as rewriting a source, and screening does plain text
comparisons against that source. A comparison can't be persuaded, and it
costs nothing.

### Why never let the AI write without a reference?

Asked for "general video game music facts" with nothing to go on, a small
model states confident errors, such as crediting Final Fantasy VII to the
wrong composer, and there's nothing to check them against. Hand-checked
facts the streamer has chosen are better than invented ones. Packs can be
split by genre so a channel only draws on music it plays: a Tetris fact under
a Chopin nocturne is a non-sequitur.

Topic-pack facts are the one thing shown without screening, since there's no
reference to check them against. That's why the project ships them only as
examples and leaves each streamer responsible for their own.

For the same reason, a short result is never padded. Four facts about the
right song beat four plus one unrelated one.

### Why is choosing the article so careful?

Wikipedia's search never says "nothing found". It always returns its closest
match, so a song with no article gets matched to something merely similar,
and the AI then writes accurate facts about the wrong thing. Screening can't
catch that, because the captions do match their reference. So
`isRelevantArticle` checks every search result first. It:

- compares whole words in order, not loose substrings;
- respects sequel numbers, so "Final Fantasy X" doesn't match "Final Fantasy"
  or "Final Fantasy X-2";
- rejects longer titles that merely contain the name ("Queen" is not "Long Live
  the Queen");
- reads Wikipedia's own labels, such as "(video game)", "(band)" or "(Debussy)";
- ignores accents, so "Pokemon" matches "Pokémon".

A track's own article ("Bohemian Rhapsody") is only accepted if its text
mentions the game or artist, because a track called "Overture" would
otherwise match the general article about overtures.

### Why is the game read from the artist field?

Game-music song lists usually put the track in the title and the game in the
artist field. `resolveGameAndTrack` is the one place that handles this. If
every song suddenly gets generic facts, check it first.

### What gets remembered between songs?

- A found article is kept for the session.
- "No article" is kept for ten minutes, then retried. A timeout or rate limit
  is never remembered, because the question was never actually answered.
- For a **game**, both are shared by all its tracks, since a set often works
  through one soundtrack.
- For an **artist**, each song keeps its own, so one Queen song's article is
  never reused for another.

Telling a game from an artist is a guess (a well-known name, or a
"Firstname Lastname" shape). When it mistakes a game for an artist, the only
cost is some extra lookups.

### Why are the prompts so literal?

They're written for a 3-billion-parameter model. What steers a model that
small is mechanical: the source before the task, the game named explicitly,
and an alternative for each thing it mustn't guess ("if the source names no
composer, write about something else"). Instructions like "be accurate" do
nothing at that size. Improve the prompt before adding another layer.

### StreamerSongList details

Every request needs the access token. The queue's `playing` slot is what's on
now; the first item in `items` is the *next* song and is only a fallback.
Live updates come through a one-way WebSocket, and every queue-related event
does the same thing: re-read the queue. So a missed or renamed event costs at
most one 15-second check. If an update arrives while a read is already
running, the queue is read once more afterward, since the running read may
be from before the change.

### StreamElements details

A second song source, for musicians who take requests through StreamElements'
Media Request player. It hands the server a queue entry in StreamerSongList's
shape, so nothing after "find what's playing" changes. The entry has a title,
an artist, the requester and the length; there's no play count, note or
live-learn flag, so the facts built from those simply don't appear.

- **`/playing` isn't "now playing".** When nothing plays, it returns the next
  song ready to play. So `/player` decides: a song counts only while its state
  is `playing`. Paused on the same song keeps it (a streamer pausing to talk
  shouldn't restart the bubbles); any other song while paused is only the next
  one up, so the overlay clears.
- **Events mean "fetch again",** exactly as with StreamerSongList. Astro, the
  realtime service, sends play, pause, skip and queue events on the
  `channel.songrequest` topic; every one, and every reconnect, triggers one
  debounced fetch. Polling every 15 seconds (30 while events arrive) is the
  safety net. 429 and 503 answers back off for as long as `Retry-After` says.
- **Titles are YouTube titles.** `parseVideoTitle` splits "Artist - Song",
  drops the upload's labels ("(Official Video)", "[4K]", "ft. X"), reads the
  work from "| Game of Thrones", "(From "Frozen")" or "(... OST)", and falls
  back to the uploader's channel, trusting it only for official ones
  ("CiaraVEVO", "Ciara - Topic"). Game music often comes as "Track - Game";
  the two sides swap only on a clear sign (the channel names the right side, the
  right side is a soundtrack, or only the right side has a "Series: Subtitle").
  A wrong guess costs a missed article and custom facts, never facts about the
  wrong song, because article matching still checks every result.

### OBS details

- **Animate only `transform` and `opacity`.** OBS draws browser sources without
  graphics acceleration, so animating anything else costs CPU and drops frames.
- **OBS serves a Local File from `http://absolute/<path>`, never `file://`.**
  The overlay treats both as "local" and connects to the fixed `SERVER`
  address; checking only for `file:` sent it to a server named "absolute".
  `overlay-connection.test.ts` runs the real script under both addresses.
- **Load the overlay as a Local File.** A URL source that fails when OBS starts
  never retries; a local file always loads and keeps reconnecting on its own.
  That's also why the server's address is written into the page (the `SERVER`
  constant): a local file can't be given settings any other way.
- **Don't use `requestAnimationFrame` to start animations.** It pauses while
  OBS isn't drawing the source, so bubbles created then would never appear.
  The page forces a style update instead.
- **The banner and the bubbles have separate timers,** so facts arriving right
  after a song change can't cancel the banner's fade-out.
