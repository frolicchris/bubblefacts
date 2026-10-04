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
| **Tagged custom facts** | A custom fact starting `[Name]` goes only with the song, artist or game it names (`taggedFactsFor`). Tagged for the song itself, it goes first, with the usual facts filling the slots left. Tagged for the artist or game, it joins a pool those songs share (`taggedFor`, `takeTurns`): one per song, second, the longest unused first, so a game with 200 songs on a list doesn't open each the same way; when no source knows the song, the pool fills its bubbles first; a song with its own facts gets one too while there's room, ahead of the creator's link. Turns reset when the app restarts. It never joins the any-song pool. A tag without a version matches every version of the title (`[Take On Me]` goes with `Take On Me [Instrumental]`, a tag song lists add often). A tag that names a version in brackets goes only with that version (`[Night Drive (Acoustic)]` never goes with `Night Drive (Remix)`), compared the way song facts are (`songIdentity` in `song-facts.ts`), with the list's own tags after it still allowed. |
| **Custom facts** | The streamer's own facts for any song no source knows. In the app, only their own lines; the command-line version can also use the example topic packs (`topics/`), which are examples, not maintained content. |
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
| `backend/src/song-search.ts` | Finds songs on the StreamerSongList list for the song facts editor. |
| `backend/src/session.ts` | What the stream has seen, kept across a restart, in `session.json`. |
| `backend/src/wrong-facts.ts` | Sources marked **Wrong**, per song, in `wrong-facts.json`. |
| `backend/src/wrong-target.ts` | Which fact a click on **Wrong** means: the one on stream now, or an earlier play's. |
| `backend/src/shown-log.ts` | The `[Shown]` log lines, once per fact per play. |
| `backend/src/stat-facts.ts` | Builds entry facts. |
| `backend/src/topic.ts` | Loads the topic packs named in `TOPIC`. |
| `backend/src/server.ts` | Sends songs and facts to the overlay; `/health`, `/recent` and the app's `/control` routes. |
| `frontend/obs/` | The overlay page itself: plain HTML, CSS and JavaScript with no build step. |

New to the fact checking? Start with `screenClaims` in `fact-verifier.ts`
(what makes a caption pass) and `fetchGrounding` (how the article is chosen),
then `generateRest` in `fact-generator.ts`, which ties them together.

### The desktop app

The app runs the same server as a child process and adds setup, settings,
sign-ins and the built-in AI. Its design decisions are in
[DESKTOP-APP.md](DESKTOP-APP.md).

| File | Job |
|---|---|
| `desktop/src/main.ts` | The app itself: window, tray, starting and restarting the server, and every request from the window (`ipcMain.handle`). |
| `desktop/src/preload.ts` | The only functions the window can call, passed through to `main.ts`. |
| `desktop/renderer/index.html`, `app.js`, `app.css` | The window: setup, dashboard, settings and About. Plain JavaScript, no build step. |
| `desktop/src/supervisor.ts` | Runs the server, checks its health, restarts it after a crash or stall, and moves its port if needed. |
| `desktop/src/settings.ts` | Settings: loading and saving (secrets encrypted), and turning them into the server's environment. |
| `desktop/src/signin.ts` | Sign in with StreamerSongList (OAuth with PKCE) and its token refresh. |
| `desktop/src/twitch.ts` | Connect Twitch (device code) and reading another channel's About. |
| `desktop/src/model.ts` | Downloading the built-in AI model. |
| `desktop/src/overlay.ts` | Copying the overlay page to the folder OBS loads it from. |
| `desktop/src/updater.ts`, `checks.ts` | Finding, checking and installing a new version; connection checks. |
| `desktop/src/backup.ts` | Automatic and manual backups of settings and facts. |
| `desktop/src/handsfree.ts` | **Hands-free Wrong**: the global key a foot pedal or Stream Deck sends. |
| `desktop/src/reports.ts` | The prefilled GitHub reports, with secrets removed. |

## The life of one song

1. **Find what's playing.** The song source reports a queue entry (see
   [Song sources and YouTube titles](#song-sources-and-youtube-titles)).
   `setCurrentSong()` tells the fact generator, which drops AI work for any
   other song.
2. **Tell the overlay.** It shows the Now Playing bubble right away, before
   any facts exist.
3. **The streamer's song facts come first.** If `findSongFacts` matches, those
   lines are shown exactly as written, with no lookup or AI, even for a live
   learn (often another music content creator's off-list original). Not cached, so an edit
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
   A music article in parts ("Music of Genshin Impact": Mondstadt, Liyue,
   Fontaine...) is cut to its lead and the part the track names ("Liyue:
   Relaxation in Liyue"), and captions naming another part are dropped
   (`soundtrackPart`): every name in a Mondstadt fact is in the article, so
   nothing else catches it under a Liyue track. A track named after something
   the article never mentions ("Ganyu: Radiant Dreams", a character) belongs
   to a part no one can tell, so the reference keeps only the lead and the
   general sections (musicology, reception), and every part counts as another
   part. This applies only when the article's lead calls it a soundtrack or score.
   Music-video sections, with their plot, production and fashion
   subsections, never go into a reference (`withoutVideoSections`): told as
   facts, a video's story reads as if it happened.
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
   just a role word nearby; an ambiguous credit is dropped. "Wrote" counts as
   composing only next to music ("wrote the score"), never "wrote the story",
   and names sharing a credit ("wrote it with A and B", "along with
   co-producer C") must share it in the source. A fact's given name must go
   with the surname in that sentence ("Paul Williams" isn't credited by "John
   Williams composed"), though a bare surname there still counts, for other
   romanizations. A console named only
   inside a sibling's name ("Wii U", "PlayStation 4") doesn't support the
   console itself.
   A small model joins two true statements with a word of its own: "due to",
   "after", "for the first time", "originally intended", "twice", a count.
   Such a word, and any number, must be in the sentence the caption retells
   (`unsupportedConnective`); the prompt asks the same. Words for how people
   are related or what they play ("brother", "guitarist", "self-titled")
   must be in a source sentence naming them (`unsupportedRelation`). Of two
   near-duplicates, the one closer to its source sentence is kept.
   The same check covers words that change what the sentence says:
   "inspired by" where the source says "resembles", "inspiring X to" where it
   says one piece resembles another, "originally titled" or "originally a
   cover" where the source just names it, "born" for a baptism date, and
   "first" (which may also sit in a closely related sentence). "A after B"
   is dropped when the sentence it retells says "after A, B".
   Three slips keep a detail but drop what it belongs to (`lostQualifier`):
   two chart peaks put on one chart ("numbers 15 and 16 on the Hot 100" when
   the second was Cash Box), "her second single" when it was the second single
   from her third album, and a single's full release date given to the album
   it came from. Three more tell a statement with another subject: "the band"
   for what the source says "the company" did, a speaker the sentence names
   only inside "an interview with" (`swappedSubject`), and a critic's reading
   ("described the cue as a compromise") told as fact without the critic
   (`unattributedView`). On an article that isn't the song's own (the
   artist's, the game's), a caption opening "The song", "The musical" or "The
   collection" reads as the song being played, so it must retell a sentence
   that names that song.
   A caption saying someone said, described or recalled something needs a
   source sentence giving that person's words or view, in (or just before)
   the sentence it retells or another it draws on; a pronoun ("he has
   acknowledged"), a passive ("defined by creator X") or one part of the name
   counts. Quoted words in such a caption, even one or two, must be in a
   sentence giving that person's words (`misattributedWords`): a small model
   turns a co-writer credit into "X described the song as 'very emotional'".
   A caption opening on a full name is dropped when the sentence it retells
   never names that person and opens on someone else (`otherDoer`), and
   "B's voice actor" is dropped when the source says "A's voice actor B"
   (`reversedRole`). "The duo", "the quartet" or "the pair" must be what the
   source says its subject is ("The band" fits any group), and "this chart"
   must come with the chart's name (`unnamedReference`): the caption that
   named them may have been dropped. A hedge ("may have", "reportedly") in
   every sentence a caption retells must stay, unless it sits inside
   someone's quote (`droppedHedge`). A year must be in the sentence the
   caption retells, a closely related one, or the one just before or after,
   and in the clause it retells when a semicolon splits that sentence
   (`misplacedYear`: the 1805 premiere told as the date of an 1807 encore).
   `wrongOwner` drops what the source says of the music video told of the
   song, sales figures that belong to the single told of the album, and a
   radio date told as a chart peak's date; `lostQualifier` also catches
   "released her debut EP on 10 May" when 10 May dates the single from it.
   "An exception to X" must have "exception to" in the source; otherwise the
   caption supplied what it is an exception to, and a small model gets that
   backwards (`suppliedException`). "A after B" is also dropped when the
   source says "B when A".
   Most wrong subjects can't be seen in the words alone
   ("B scored the games" when the source says A did, and B scored only the
   film); for those the prompt asks to keep each statement's subject, verb
   and details together.
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
the project ships topic packs only as examples for the command-line version,
the app doesn't offer them at all, and each streamer is responsible for their own. (Structured facts need no
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
- **A generic track names no installment.** "Main Theme" is in every
  installment's article, so it never makes one the song's game.

Song lists also write requests the usual reading misses. `readings` gives the
other ways to read one, each checked by all the rules above:

- **A category as the artist** ("Star Trek TV", "NieR Series", "Super Mario
  Franchise"): the work named in the title ("Star Trek: Picard Season 1
  Theme" is from *Star Trek: Picard*), then the series' own article ("Kirby
  (series)"), never one installment. A film or show category never matches a
  video game. A title with a name in brackets gets no series article: it may
  be from another game ("Aquatic Ambiance (Donkey Kong Country)").
- **An arranger** ("Elton John arr. Brent Edstrom"): the name alone.
- **Several names** joined by "/", " - ", " x " or "ft." ("Frederic
  Chopin/Arranger", "Queen - David Bowie", "Titanic - Celine Dion"), the
  main name not always first: the song's own article under each name first,
  then the work named in the title (below), and only then a name's own
  article: only for a name that reads like a person's, and only an article
  that opens by calling it a performer ("Black Caviar" is a duo and a
  racehorse), or a game's or a show's own article under that very name
  ("Kingdom Hearts / Some Remixer"). A short tag of one or two capitals after the names ("Some
  Singer - AB") is a list's own mark and is dropped; with one name left,
  that name is simply the artist.
- **No one** ("Traditional", "Italian Folk Song"): the title alone, and only
  an article that opens by calling it a song ("Santa Lucia" is also a town).
- **Someone else's song in the title** ("Baby (Justin Bieber)" by a cover
  band, "Wind (Naruto)"): the name in brackets, for the song's own article
  only, which must name it.
- **The work after or before a dash, the artist a remixer** ("Gerudo Valley -
  Ocarina of Time"): the song's own article, or the work's, which must be a
  game, a film or a show by its brackets or its first sentence ("Aladdin" is
  also a folk tale; a composer's article opening "a film score composer"
  isn't a film). No "video game" search for it: "The Mask" is a film first.
  Read the other way round, the piece's article must open by calling it a
  piece of music: "Overwatch" read as a track name isn't "Overwatch and
  pornography". Nor is any "X and something" article about X; "Pokémon Red
  and Blue", a pair of names, still is.

Version tags are dropped before any reading: at the end, glued to the title
("Beat It(Arrangement)"), before a dash, or after one ("Numb - 80's Remix").
A tag counts when it starts with a way of playing ("Acapella", "Lofi",
"Original", "Live") or ends with what kind of version it is ("Chill Version",
"Children's Choir Remix", "2020 Performance"). A dash part that also names a
work keeps the work: "Let the Battles Begin - FFVII Remix" is from "FFVII".

After a miss, Wikipedia's own name for the subject is tried: an exact-title
redirect ("Star Wars: The Phantom Menace" to "Star Wars: Episode I – The
Phantom Menace") or the search's spelling suggestion ("Eric Satie" to "Erik
Satie"). Not our fuzzy guessing, and still careful:

- A redirect must lead to the same thing under its proper name: not a list,
  an album, or one of several ("Johann Strauss" leads to Johann Strauss II).
  Nor to a company named like it ("Qumu" leads to Qumu Corporation), nor
  from a plural ("Memes" isn't "Meme"), nor to a disambiguation page that
  opens with its main meaning ("2am" leads to "2 A.M.", a time of day).
  A redirect from initials counts when they spell the title, installment
  number included ("FFVII" to "Final Fantasy VII"). The abbreviation is
  Wikipedia's own redirect, never our table.
- A suggestion must be a respelling (a letter or two, in one word), name an
  article, and be among the search's own hits: "Windy Harper" is never
  "Wendy Harmer".
- The renamed subject is that very page, not whatever a search for its name
  finds first ("Pirates of the Caribbean", not its video game).

**Does the article fit the request?** A found article is checked once more
against the request as typed (`articleMisfit`), on the whole article read
this session. Its opening must say it is about a song, a record, a
performer, a composer, a soundtrack, a game, a film or a show: the biblical
"Jezebel" (for Sade's song) and "YouTube" fail. It must name the character a
"(Name's Theme)" bracket names and the work in an artist field's subtitle
("Star Wars: Rogue One" isn't the 1983 Atari game); a stage name in brackets
isn't required, since a game's article rarely lists stages, and a person's
piece may carry a translated title. A misfit is passed over and the lookup
tried again without it, twice at most. Queue placeholders ("Off-List YouTube
Request < 5 Min (Free)") aren't looked up at all.

### Why is the game read from the artist field?

Game-music song lists usually put the track in the title and the game in the
artist field. `resolveGameAndTrack` is the one place that handles this. If
every song suddenly gets generic facts, check it first.

An artist that is a streamer's handle (`@name`, `Name (@name)`) is a fellow
streamer's piece: nothing is looked up, and the streamer's own facts are used.

### How do I see what a stream showed?

Each fact sent to the overlay is logged as `[Shown] "Song" (source): text`,
next to the `[Screen] DROP` lines for what was held back. It's logged where
the facts go out (`broadcast` in `server.ts` after the pause check, and an
overlay's catch-up), not where they're written, so a skipped, paused or
superseded song's facts aren't in it. Each fact is logged once per play of a
song, however many overlays get it (`shown-log.ts`); nothing is logged while
no overlay is connected, and the first one to connect gets them, logged then.

### What gets remembered between songs?

- What was shown is saved to `session.json` in the data folder: after a
  restart mid-song, or an overlay that reloads, only the bubbles still to come
  are sent, and earlier songs' facts aren't repeated. A fact taken off with
  **Wrong** is dropped from it too, so a restart doesn't bring it back.
  Forgotten after 6 hours.
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
  but nothing has been followed for 30 s (`FOLLOW_GRACE_MS`). With the live
  events down there's no live state, and REST can stay `paused` after a
  resume (issue #16), so the sign then is a song change under `paused`: a
  paused player stays on its song, so `/playing` naming a different one than
  when the pause was first seen (`pausedOn`), unfollowed for 30 s, is a
  problem too. Health says degraded, the dashboard says Reconnecting, and
  after `DEGRADED_BEFORE_RESTART_MS` (2 minutes) the app restarts the server,
  which reconnects the events. A pause on one song, however long, is never a
  problem, and neither is a stopped player's next song up. A restart starts
  with the song the player is on as `pausedOn`, so it can't repeat; a
  streamer who skips while paused gets at most that one restart.
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
  album with no secondary type) when there is one. The year comes only from
  releases that aren't compilations, live albums or remixes (a 1988 jazz
  compilation isn't when "It's Only a Paper Moon" came out), and is left
  out when the credited artist had died by then (a Satie piece on a 1995
  album). An "additional" composer, such as a fanfare quoted in another
  composer's cue, isn't named.

### Wrong and Undo

```
Wrong   → POST /control/wrong {text, song, live}
        → wrongTarget(): live (clicked under On stream now) and still on → the song on now;
          otherwise that song's play in the earlier list (hands are busy mid-song)
        → markWrong(): the fact's own source label decides (blockFor)
             "Wikidata" / "MusicBrainz"   → blocks STRUCTURED ("Wikidata and MusicBrainz")
             "Wikipedia: <title>"          → blocks that article
             the streamer's or song list's → blocks nothing
           a live learn is blocked under the song it was looked up as too
        → blockArticle() saves wrong-facts.json; the song's cached facts are dropped
        → song on now: overlay gets remove_fact, even mid-bubble; session.json drops it
        ← {removed, live, article, structured}
Hands-free Wrong (a global key from a foot pedal or Stream Deck)
        → POST /control/wrong-current {}
        → factOnScreen(): the bubble up now, else the one shown last for this song
        → then exactly as Wrong on the song on now
        ← {removed, live, article, structured, text, song}  or  {removed: false, reason}
Undo    → POST /control/unwrong {article, song}
        → unmarkWrong() lifts the block; the fact stays off for this play
        ← {restored}
```

`wrong-facts.json` maps `songKey` (`ssl:<id>` for a list song, `yt:<id>` for a
video, else `artist:::title` lowercased) to blocked article titles and the
`STRUCTURED` marker. Undo sends the song in full, IDs included, so it lifts
the same entry. The label is used rather than what's in memory, so Wrong is
right after a restart and on an earlier song. The app sends the song that was
on when **Wrong** was pressed, so **Undo** can't land on the next song.

The window also says which list was clicked (`live: true` only from **On
stream now**). The song alone can't tell: when a song plays again (A, B, A),
its earlier play under **Earlier songs** is the same song as the one on, and
**Wrong** there took the live bubble off. A click under **Earlier songs**
always marks that earlier play and never touches the stream. A live click
whose song has moved on finds the fact under **Earlier songs** instead.

**Hands-free Wrong** asks the server, not the overlay, which bubble is up: it
knows when the facts went out (`factsShownAt`) and each one's delay, and
`readingSeconds` in `session.ts` mirrors the overlay's (keep them the same).
Delays count from `factsShownAt`, so a resumed or restarted song works
unchanged. A press within 1.5 seconds of a new bubble, while the one before
is still up, means the one before (`JUST_APPEARED_SECONDS`): the musician
reacted to what they read. Nothing is marked while paused, before any bubble
has gone out (no overlay connected counts), or for a song with no facts; the
reason (`paused`, `no-song`, `not-ready`, `no-facts`, `none-shown`) becomes
the dashboard's note. The test bubble is never in `lastSent`, so it's never
the one marked.

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

The overlay's WebSocket (`/ws`) only accepts an `Origin` of OBS's Local File
address (`http://absolute`), a page the server served itself, or none (not a
browser). Any other page, including the overlay opened from `file://` in a
browser, is refused with a `[WS] Refused a connection` line. The overlay never
sends anything, so messages over 1 KB close the connection, and at most 16
overlays can connect.

Request titles, artists and requester names are cleaned once, in
`SongListClient.toSong` (`cleanRequestText`): one line, at most 200
characters. In prompts, a title's double quotes become single quotes so it
can't close the quotes around it. Whatever the source says, `screenClaims`
drops a caption with a link, a chat command or an `@mention`.

| Route | Used for |
|---|---|
| `/control/test` | **Show a test bubble**, even while paused. A `test_bubble` message, drawn on top of the song that's playing: that song's remaining bubbles, and **Wrong** on them, carry on. Returns how many overlays got it. |
| `/control/pause` | **Pause bubbles** / **Resume bubbles**. While paused, songs are still followed, nothing is shown. Resuming on the same song sends its unshown facts without a second Now Playing bubble; a new song starts normally. The app restarts a crashed or stalled server with `BUBBLEFACTS_PAUSED=1`, so it stays paused. |
| `/control/wrong`, `/control/unwrong` | **Wrong** and **Undo** (above). |
| `/control/wrong-current` | **Hands-free Wrong** (above): the bubble on stream now, or the one shown last for this song. |
| `/control/song-facts/get`, `/control/song-facts` | **Add facts for this song**: read, then save (up to 20 facts of up to 300 characters, 5 songwriters, a 200-character link). Over a limit, the save is refused with `error`, a reason the editor shows; nothing is trimmed. Answers as soon as it's saved (the app waits 3 seconds at most), then shows them if the song is still on. |
| `/control/songs/search` | **Add facts for another song**: songs on the StreamerSongList list whose title or artist contains every word typed (case and accents ignored), titles starting with it first, at most 8 by default. Searches the copy read at start (`learnListFormat` keeps id, title and artist), so a song added to the list later shows after a restart; a read that failed is retried on a search, at most once a minute. Picking one saves the facts with its song ID. `available: false` with StreamElements, which has no list. |
| `/control/selftest` | `scripts/smoke-packaged.mjs` writes and screens real captions for two songs at once, through the turn-taking queue. |

`GET /health` and `GET /recent` (the song and facts last sent) need no header.

### What every 2.x release keeps working

2.0.0 is the first stable release, and from it on these are the app's
public interface: a change that breaks one waits for 3.0 (SemVer).

- **Settings** (`settings.json`): a version reads any older 2.x file. A
  setting it doesn't know is kept when it saves, so going back a version and
  forward again loses nothing. `settingsVersion` records the format.
- **Facts files:** `song-facts.json`, `wrong-facts.json`, and the custom
  facts in settings.
- **Backups:** `formatVersion` 1; a newer format is refused with a plain
  message, never half-read.
- **The OBS source:** the overlay file's path in the data folder and the
  server's address and port, so a scene set up once keeps working.
- **The update path:** any 2.x, beta or release candidate updates straight to
  the newest 2.x in the app.

### Files in the data folder

The server keeps its few files in `BUBBLEFACTS_DATA_DIR` (the app's data
folder; `data/` for the command-line version):

- `song-facts.json`: the streamer's song facts, matched by StreamerSongList
  song ID, YouTube video ID, else artist and title, or an alias. The match
  ignores case, accents and punctuation but keeps every word, so
  "Night Drive (Acoustic)" isn't "Night Drive (Remix)". A songwriter is
  credited only when the streamer names one.
- `wrong-facts.json`: sources marked **Wrong** (above).
- `session.json`: the song that was showing, its facts, when they went out,
  and recent facts (see "What gets remembered between songs?").

These, `settings.json` and backups are written to a temporary file beside
them that then replaces the old one (`atomic-write.ts`, one copy for the
server and one for the app), so a crash mid-write leaves the old file whole,
never half of one.

The app's own files sit beside them: `settings.json`, `models/`, `overlay/`,
`facts/` (the streamer's custom facts, as a pack), `logs/` and `backups/`
(automatic copies of the settings and facts, never sign-ins, keys or which
AI writes the facts). **Remove my
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
  never retries; a local file always loads and keeps reconnecting on its own,
  every 1 to 4 seconds (`MAX_RECONNECT_MS`), so OBS picks the app up within a
  few seconds of it starting.
  That's also why the server's address is written into the page (the `SERVER`
  constant): a local file can't be given settings any other way.
- **Don't use `requestAnimationFrame` to start animations.** It pauses while
  OBS isn't drawing the source, so bubbles created then would never appear.
  The page forces a style update instead.
- **The banner and the bubbles have separate timers,** so facts arriving right
  after a song change can't cancel the banner's fade-out.
