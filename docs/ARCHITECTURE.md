# How it works

This is for anyone changing the code. It explains how a song becomes fact
bubbles, and why the less obvious parts are the way they are. Each of those
decisions came from something going wrong on a live stream, so please read
the relevant section before changing it.

## Words used here

| Term | Meaning |
|---|---|
| **Queue entry** | The song playing now, as the song source reports it: title, artist field, and with StreamerSongList also play count, notes and requester. |
| **Grounding** | Finding the song's Wikipedia article and pulling out the useful text. |
| **Reference** | That article text, handed to the AI as its only source. |
| **Screening** | Checking each caption the AI wrote against the reference, and dropping those it doesn't support. |
| **Structured facts** | Fixed sentences filled in from Wikidata or MusicBrainz data. No AI. |
| **Song facts** | Facts the streamer wrote for one particular song (**Add facts for this song**). |
| **Tagged custom facts** | A custom fact starting `[Name]` goes only with the song, artist or game it names (`taggedFactsFor`), first, with the usual facts filling the slots left. It never joins the any-song pool. |
| **Custom facts** | The streamer's own facts for any song no source knows: their own lines, plus any example topic packs (`topics/`) they turned on. The packs shipped are examples, not maintained content. |
| **Entry facts** | Facts built from the queue entry itself: "played 12 times", "requested by X". |

## The pieces

```
StreamerSongList ─┐ REST + live events                 WebSocket
StreamElements ───┴──────────────► Server ──────────────────────► Overlay in OBS
                                     │
   song facts → Wikipedia → AI → screen → Wikidata / MusicBrainz → custom facts
```

| File | Job |
|---|---|
| `backend/src/song-source.ts` | The `SongSource` interface the server needs from a song source. `SONG_SOURCE` picks one. |
| `backend/src/songlist-client.ts` | StreamerSongList: reads the queue and works out what's playing. |
| `backend/src/centrifugo-client.ts` | StreamerSongList's live "the queue changed" events. |
| `backend/src/streamelements-client.ts` | StreamElements: reads the song request player and works out what's playing. |
| `backend/src/astro-client.ts` | StreamElements' live song request events. |
| `backend/src/youtube-title.ts` | Reads a song and artist out of a YouTube video title. |
| `backend/src/youtube-metadata.ts` | Reads the exact song and artist of YouTube's auto-generated "- Topic" uploads. |
| `backend/src/fact-generator.ts` | Decides how to handle each song, talks to the AI, caches results, handles **Wrong**. |
| `backend/src/fact-verifier.ts` | Finds the right Wikipedia article and screens the AI's captions. |
| `backend/src/wikidata.ts`, `backend/src/musicbrainz.ts` | Structured facts when there's no article about the song. |
| `backend/src/song-facts.ts` | The streamer's song facts, in `song-facts.json`. |
| `backend/src/wrong-facts.ts` | Sources marked **Wrong**, per song, in `wrong-facts.json`. |
| `backend/src/stat-facts.ts` | Builds entry facts. |
| `backend/src/topic.ts` | Loads the topic packs named in `TOPIC`. |
| `backend/src/server.ts` | Sends songs and facts to the overlay; `/health`, `/recent` and the app's `/control` routes. |
| `frontend/obs/` | The overlay page itself: plain HTML, CSS and JavaScript with no build step. |

## The life of one song

1. **Find what's playing.** The song source reports a queue entry (see
   [Song sources and YouTube titles](#song-sources-and-youtube-titles)).
   `setCurrentSong()` tells the fact generator, which drops AI work for any
   other song.
2. **Tell the overlay.** It shows the NOW PLAYING banner right away, before
   any facts exist.
3. **The streamer's song facts come first.** If `findSongFacts` matches, those
   lines are shown exactly as written, with no lookup or AI, even for a live
   learn (often another streamer's off-list original). Not cached, so an edit
   applies on the next play.
4. **Special cases.** A live learn (a request that isn't on the song list)
   gets its banner, and facts only from a source (`liveLearnLookup` reads
   an artist and title out of a request typed like a video title), never
   song-list or custom facts. The streamer's own composition gets entry
   facts and their composition notes, with no lookup.
5. **Read the request.** Streamers write song lists differently: the game in
   the artist field, "Game - Track" with the composer as artist, "Track -
   Show" with the performer, "Track (Film)", "Track from Show". At start the
   song-list client reads the whole list once and `list-profile.ts` works out
   its habits (sources repeat across a list; track names don't). Each song
   then has one or more `readings`, tried in order until one finds an
   article; an article that is only the artist's biography is kept as a last
   resort. Measured on seven public lists (about 10,800 songs).
   **Ground.** Search Wikipedia for the song, game or work, reject results that
   aren't really about it or that the streamer marked **Wrong** for this song,
   and pull out the music-related sections first. A game's track with an
   article of its own ("Megalovania") is tried before the game's article: one
   extra search per track.
   A game's track without one gets a reference built for it (`gameTrackText`):
   the game's music article when Wikipedia has one ("Music of Chrono
   Trigger", "Undertale Soundtrack"; a series-wide one only for tracks it
   names; never a film's soundtrack), led by the sentences that name this
   track. The game's articles are kept whole per game, so its other tracks
   need no new download.
   The reference then leads with three kinds of sentence lifted from anywhere
   in the article (issue #48), because a character budget never reached them:
   what the makers said (`creatorSentences`: a cue like "said", "recalled" or
   "inspired by", about the music, someone named, critics and the press left
   out), how the music is built (`theorySentences`: key, tempo, chords, form)
   and how it was received (`receptionSentences`: charts, awards,
   certifications, sales, never opinions). In an article about a whole game
   or artist, only sentences that name the track or are plainly about music
   are lifted, and no reception.
6. **Write.** The AI rewrites details from the reference as short captions,
   at a low temperature. Its instructions are laid out as CROSS (Context,
   Role, Objective, Source, Scope); `PROMPT_STYLE=rules` uses the older
   numbered list.
7. **Screen.** `screenClaims` drops captions the reference doesn't support:
   names, roles ("composed by"), years, consoles, award, chart and sales
   claims, opinions, talk about the video, commentary about the source, length
   and near-repeats of recent facts.
   Words in quotation marks must be in the source exactly and run to twelve
   words at most (`alteredQuote`). A caption opening with "He" or "She" is
   dropped: a viewer can't tell who. Music terms get a few fixed plain words
   (`explainMusicTerms`), never the model's own explanation.
   A credit needs a source sentence that ties the person to the role
   (`statesRole`: "Chen composed", "composed by Chen", "composer Chen"), not
   just a role word nearby; an ambiguous credit is dropped.
   `restatesRequest` then drops, on every path except the streamer's own
   typed facts, any caption that is only the title, artist or game plus
   filler ("a song by", "written by", genre). Spares fill the gap.
8. **Structured facts.** With no article, `wikidata.ts`, then `musicbrainz.ts`,
   fill fixed sentences, with no AI and so no screening. When the article is
   the artist's or the game's rather than the song's, structured facts about
   the song go before the AI's captions.
9. **Fall back if needed.** No source, a failed AI call, or nothing that
   passed screening all lead to the same place: entry facts plus custom
   facts, or nothing when the streamer has none (the app's default). The AI is
   never asked to write without a reference.
10. **Send.** The overlay shows one bubble every `FACT_INTERVAL_SECONDS`,
    counting from when the facts arrive. If the song has already changed by
    then, it throws the batch away. Each fact carries a `source` label for the
    dashboard: `Wikipedia: <article>`, `Wikidata`, `MusicBrainz`,
    `Your song list`, `Your custom facts` or `Your facts for this song`.
    A fact from an article also carries the article's link and the sentence
    it most likely came from (`supportingSentence`: the one sharing at least
    half its content words), which the dashboard shows when the source is
    clicked.

Facts are kept in memory for the rest of the session, so a repeated song is
instant; nothing generated is ever written to disk. Several requests for the
same song at once (two overlays, or one reconnecting mid-song) share a single
generation. Songs that fell back are retried after ten minutes, and song facts
and originals are rebuilt every time, so edits, the play count and the
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

The streamer's own facts (custom facts and song facts) are the only text shown
without any check, since there's nothing to check them against. That's why
the project ships topic packs only as examples, off by default in the app,
and leaves each streamer responsible for their own. (Structured facts need no
screening: they're fixed sentences, and only the data in them varies.)

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
otherwise match the general article about overtures. More rules in
`fetchGrounding`, each from a real wrong match:

- **Installments must name the track.** A game match that extends the name
  ("Final Fantasy" to "Final Fantasy VII", "Undertale" to "Undertale Yellow")
  is used only if its text mentions the track, and isn't shared with the
  series' other tracks.
- **Performers aren't games.** When the upload is a music video
  (`song.performer`), band and singer articles match, game, film and TV
  articles don't, the search asks for "`<name>` band", and an article with no
  label in brackets must open like one about a performer ("Milestone" the
  road marker doesn't).
- **For an artist, the song's own article wins** over the artist's, wherever
  it ranks ("Industry Baby" over "Lil Nas X"). A song article only has to
  mention the lead artist of a multi-artist credit.
- **A guessed artist is never the subject.** If the artist only came from the
  uploader's channel (`song.artistUncertain`), only the track is searched: an
  uploader called "Apollo" isn't the god.
- **Blocked articles are skipped.** Anything the streamer marked **Wrong** for
  this song (`blockedArticles`), even if it's cached.

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
- For an **artist**, or a music video's performer, each song keeps its own,
  so one Queen song's article is never reused for another.
- Wikidata and MusicBrainz work the same way: a match is kept for the
  session, "no match" for 30 minutes.

Telling a game from an artist is a guess (a well-known name, or a
"Firstname Lastname" shape). When it mistakes a game for an artist, the only
cost is some extra lookups.

### Why are the prompts so literal?

They're written for a 3-billion-parameter model. What steers a model that
small is mechanical: the source before the task, the game named explicitly,
and an alternative for each thing it mustn't guess ("if the source names no
composer, write about something else"). Instructions like "be accurate" do
nothing at that size. Improve the prompt before adding another layer.

### Song sources and YouTube titles

Every source implements `SongSource` (`backend/src/song-source.ts`) and hands
the server a queue entry in StreamerSongList's shape, so nothing after "find
what's playing" depends on the source. The server reads its methods for
`/health`: `lastSuccessfulFetchAgeMs()` and `pollIntervalMs()` (stale after
three missed polls), `authRejected()` (401 or 403: `unauthorized`), and the
optional `backingOff()` (honoring `Retry-After`, not stale) and
`followingProblem()` (a reason string: `degraded`). The desktop app restarts
the server after two minutes of `degraded`, never for `unauthorized`.

**StreamerSongList** (`songlist-client.ts`):

- REST `GET /queue`: the `playing` slot is what's on now; the first item in
  `items` is the *next* song and is only a fallback.
- Centrifugo (`centrifugo-client.ts`) on `streamer:<id>` and
  `streamer:<id>-queue`. Every publication and every reconnect does the same
  thing: one debounced re-read of the queue. Event types are never inspected,
  so a missed or renamed event costs at most one poll.
- Polls every `SSL_POLL_INTERVAL_MS` (15 s), or every 60 s while events are
  connected. An update during a read triggers one more read afterward.
- 429 and 503 back off for as long as `Retry-After` says.

**StreamElements** (`streamelements-client.ts`), for musicians who take
requests through its Media Request player:

- REST `GET /songrequest/<id>/player` (the state), then `/playing` (the song).
  `/playing` isn't "now playing": when nothing plays, it returns the next song
  ready to play. So a song counts only while the state is `playing`.
- Astro (`astro-client.ts`), topic `channel.songrequest`: `play`, `pause`,
  `song.next`, `song.previous` and `song.skip` set a live state, and every
  event and reconnect triggers one debounced re-read.
- The live state wins over the REST state, but only while the socket is
  connected (`liveState()`); a reconnect forgets it.
- Paused on the same song keeps it (a streamer pausing to talk shouldn't
  restart the bubbles); any other song while paused is only the next one up,
  so the overlay clears.
- `followingProblem()`: the live state says `playing`, `/playing` has a song,
  but nothing has been followed for 30 s (`FOLLOW_GRACE_MS`).
- Polls every `SE_POLL_INTERVAL_MS` (15 s), or 30 s while events arrive.
- The entry has a title, an artist, the requester and the length; no play
  count, note or live-learn flag, so facts built from those don't appear.

**YouTube titles** (`youtube-title.ts`). StreamElements only knows each
request's YouTube title and channel. `parseVideoTitle(title, channel)`:

1. drops hashtags and label brackets ("(Official Video)", "[4K]", "ft. X",
   also in Spanish, Portuguese, French and German), and variant brackets
   ("(Live)", "(Remix)");
2. reads the work from "(From "Frozen")", "(... OST)", "| Game of Thrones" or a
   "Series: Subtitle" bracket, and the artist from "(by X)";
3. splits "Artist - Song" on a spaced dash, `~`, ` / ` or ` // ` (never
   "AC/DC"), and swaps the sides only on a clear sign: the channel or its
   initials ("SNL") name the right side, or only the right side is a
   soundtrack or a "Series: Subtitle";
4. otherwise tries `Artist "Song"`, `X's "Song"` and "A x B";
5. falls back to the uploader's channel, trusted only when official
   ("CiaraVEVO", "Ciara - Topic").

It returns two flags for grounding. `performer`: an official video, audio,
visualizer or lyric upload, or an official channel, so the artist is a band
or singer. `confident`: false when the artist is only a guess, which the
client passes on as `artistUncertain`. A wrong guess costs a missed article,
never facts about the wrong song, because article matching still checks every
result.

**The title corpus.** Every real title that was read wrong goes in
`backend/src/fixtures/youtube-titles.json`: `title`, `channel`, the `artist`
and `song` a person would read, a `kind` (such as `official`, `game` or
`non-english`) and a `source` (such as `"stream 2026-09-30"`).
`youtube-title.test.ts` checks every case, so a new rule can't quietly break
an old title. Add the case first, then change the rules until it passes.

**Auto-generated uploads** (`youtube-metadata.ts`). Titles from "- Topic"
channels are often just the song name, but the description names the artist
exactly ("Provided to YouTube by ..."). For those uploads only,
`songFromYouTube` asks the YouTube Data API (`videos?part=snippet`, 3 s
timeout, cached for the session) and the result replaces the parsed title.
The key is `YOUTUBE_API_KEY`: the Release workflow writes the repository
secret into `package.json` for that build only, and the app passes it to the
server. It's never logged (errors log the HTTP status only). Without a key,
or when a lookup fails, the title is parsed as usual.

### Where structured facts come from

Both run only when there's no article about the song itself, need no AI and
no screening, and are skipped for a song whose structured facts were marked
**Wrong**.

- **Wikidata** (`wikidata.ts`). `wbsearchentities` in the title's own
  language (`searchLanguage`: Japanese, Korean or Russian when the title is in
  that script, else English), so 紅蓮華 finds LiSA's song. `pickSong` takes
  only an item whose label is the title and whose description is a music
  item naming the artist or game ("2021 single by Lil Nas X"), so a
  same-named song by someone else never matches. Deprecated statements are
  ignored; preferred ones win (`rankedClaims`). Statements used: composer,
  lyricist, year, album or work, producer, up to two awards, charts.
- **MusicBrainz** (`musicbrainz.ts`), only when Wikidata has nothing. One
  request at a time, at most about one a second, with a User-Agent naming
  the project, as MusicBrainz asks. For a game's track: a composer only from
  an explicit recording, then work, then composer or writer relationship,
  because fan covers crowd the search results and are even tagged
  "Soundtrack". For a performer, or a game with no such relationship: the
  first year of the artist's recording, and a studio album (official, an
  album with no secondary type) when there is one.

### Wrong and Undo

```
Wrong   → POST /control/wrong {text}
        → markWrong(): which source made this fact?
             Wikidata/MusicBrainz fact → blocks STRUCTURED ("Wikidata and MusicBrainz")
             AI caption                → blocks the song's Wikipedia article title
             song facts, custom facts  → blocks nothing
        → blockArticle() saves wrong-facts.json; the song's cached facts are dropped
        → overlay gets remove_fact, even mid-bubble
        ← {removed, article, structured}
Undo    → POST /control/unwrong {article, song}
        → unmarkWrong() lifts the block; the fact stays off for this play
        ← {restored}
```

`wrong-facts.json` maps `songKey` (`artist:::title`, lowercased) to blocked
article titles and the `STRUCTURED` marker. The app sends the song that was
on when **Wrong** was pressed, so **Undo** can't land on the next song.

### Keeping generations in order

- **One model, one turn at a time.** The built-in model has one chat session.
  Songs queue for it (`askBuiltin`); each turn resets the history and runs its
  prompt together, and stops after 90 seconds (`BUILTIN_TIMEOUT_MS`).
- **Obsolete work is dropped.** `setCurrentSong()` aborts a running built-in
  generation for another song, and a queued turn for an old song throws
  `Obsolete` when it comes up (not cached, so the song gets a real try if it
  comes back). For hosted AIs, the server ignores late results.
- **Saved song facts win.** Saving song facts calls `forgetSong()`, which
  bumps the song's revision; a generation that started before the save is
  neither cached nor returned, and its caller gets fresh facts.
- **No repeats across songs.** The last 80 facts shown (`recentFacts`) are
  kept for the session; a near-duplicate (`tooSimilar`) is dropped.

### The app's control routes

`POST /control/*` routes need the header `X-BubbleFacts: 1`. A web page in a
browser can't send it without a CORS preflight, which is never approved, so
it can't press the app's buttons.

| Route | Used for |
|---|---|
| `/control/test` | **Show a test bubble**, even while paused. Returns how many overlays got it. |
| `/control/pause` | **Pause bubbles** / **Resume bubbles**. While paused, songs are still followed, nothing is shown. Resuming on the same song sends its unshown facts without a second NOW PLAYING banner; a new song starts normally. |
| `/control/wrong`, `/control/unwrong` | **Wrong** and **Undo** (above). |
| `/control/song-facts/get`, `/control/song-facts` | **Add facts for this song**: read, then save (up to 20 facts and 5 songwriters). Shows them at once if the song is still on. |
| `/control/selftest` | `scripts/smoke-packaged.mjs` writes and screens real captions for two songs at once, through the turn-taking queue. |

`GET /health` and `GET /recent` (the song and facts last sent) need no header.

### Files in the data folder

The server keeps its few files in `BUBBLEFACTS_DATA_DIR` (the app's data
folder; `data/` for the command-line version):

- `song-facts.json`: the streamer's song facts, matched by StreamerSongList
  song ID, YouTube video ID, else artist and title, or an alias. The match
  ignores case, accents and punctuation but keeps every word, so
  "Night Drive (Acoustic)" isn't "Night Drive (Remix)". A songwriter is
  credited only when the streamer names one.
- `wrong-facts.json`: sources marked **Wrong** (above).

The app's own files sit beside them: `settings.json`, `models/`, `overlay/`,
`facts/` (the streamer's custom facts, as a pack) and `logs/`. **Remove my
BubbleFacts data** deletes all of them.

### Licenses of the sources

- **Wikipedia** text is CC BY-SA 4.0. Captions are short rewrites, and the
  site and README ask streamers to credit the sources.
- **Wikidata** data is CC0. **MusicBrainz** core data (recordings, releases,
  works, relationships) is CC0; only those fields are read, never tags or
  annotations, which aren't CC0.
- Some YouTube title rules follow Web Scrobbler's metadata-filter (MIT),
  credited in `youtube-title.ts` and on the credits page.

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
