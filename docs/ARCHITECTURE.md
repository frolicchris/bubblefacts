# How it works

*Current as of 2.1.0 (October 2026).*

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
StreamElements ───┤──────────────► Server ──────────────────────► Overlay in OBS
Now playing file ─┘ reads the file   │
   song facts → Wikipedia → AI → screen → Wikidata / MusicBrainz → custom facts
```

| File | Job |
|---|---|
| `backend/src/config.ts` | Every setting from `.env`, with its default and allowed range (documented in [CONFIG.md](CONFIG.md)). |
| `backend/src/song-source.ts` | The `SongSource` interface the server needs from a song source. `SONG_SOURCE` picks one. |
| `backend/src/songlist-client.ts` | StreamerSongList: reads the queue and works out what's playing. |
| `backend/src/centrifugo-client.ts` | StreamerSongList's live "the queue changed" events. |
| `backend/src/song-mapping.ts` | Turns a queue entry into the song the pipeline and overlay read (`toSong`, `displayTitle`); every source uses it. |
| `backend/src/source-polling.ts` | What the two web clients share: Retry-After backoff, one fetch at a time, debounce, the polling loop. |
| `backend/src/streamelements-client.ts` | StreamElements: reads the song request player and works out what's playing. |
| `backend/src/astro-client.ts` | StreamElements' live song request events. |
| `backend/src/now-playing-file.ts` | A text file a now-playing app (Streamling, Nightbot or another) keeps up to date. |
| `backend/src/now-playing-folder.ts` | Where a preset's folder is: `Documents`, or the same folder in OneDrive. |
| `backend/src/youtube-title.ts` | Reads a song and artist out of a YouTube video title. |
| `backend/src/youtube-metadata.ts` | Reads the exact song and artist of YouTube's auto-generated "- Topic" uploads. |
| `backend/src/fact-generator.ts` | Decides how to handle each song, talks to the AI, caches results, handles **Wrong**. |
| `backend/src/fact-verifier.ts` | Finds the right Wikipedia article and screens the AI's captions. |
| `backend/src/content-standard.ts` | The content standard's word lists: what no article sentence, caption or data fact may say. |
| `backend/src/wiki-html.ts` | An older article version's HTML as plain text, for the 72-hour rule. |
| `backend/src/list-profile.ts` | How one streamer writes their song list (a dash or brackets for the game), worked out from the list itself. |
| `backend/src/wikidata.ts`, `backend/src/musicbrainz.ts` | Structured facts from data: the song's year, album and credits, an artist's basics, classical pieces, and a missing artist for a bare title. |
| `backend/src/data-facts.ts` | Packs those facts into as few bubbles as fit (a song's year and album as one). |
| `backend/src/infobox.ts` | Facts from the article's own infobox, used only when it describes the requested work. |
| `backend/src/fact-ranking.ts` | Which of the captions and data facts are shown, and in what order. |
| `backend/src/credit.ts` | The credit bubble that says where the facts come from. |
| `backend/src/song-facts.ts` | The streamer's song facts, in `song-facts.json`. |
| `backend/src/song-search.ts` | Finds songs on the StreamerSongList list for the song facts editor. |
| `backend/src/session.ts` | What the stream has seen, kept across a restart, in `session.json`. |
| `backend/src/wrong-facts.ts` | Sources marked **Wrong**, per song, in `wrong-facts.json`. |
| `backend/src/wrong-log.ts` | One line per **Wrong** press in `wrong-log.jsonl` (song, caption, source, article, version, date), newest 500, private, in backups and removed with the data. `scripts/wrong-cases.mjs` replays it. |
| `backend/src/wrong-target.ts` | Which fact a click on **Wrong** means: the one on stream now, or an earlier play's. |
| `backend/src/shown-log.ts` | The `[Shown]` log lines, once per fact per play. |
| `backend/src/aired-facts.ts` | The same facts kept in `aired-facts.json` (song, fact, source, link, time), newest 500, private, removed with the data; the app's reports read it through `/control/aired`. |
| `backend/src/stat-facts.ts` | Builds entry facts. |
| `backend/src/topic.ts` | Loads the topic packs named in `TOPIC`. |
| `backend/src/local-only.ts` | Answers only to this computer: checks the Host header against DNS rebinding. |
| `backend/src/atomic-write.ts`, `text.ts`, `types.ts` | Crash-safe file writes, small text helpers, and the shared song and fact shapes. |
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
| `backend/src/share-song-facts.ts` | **Share song facts with other apps** (off by default): sends the song on stream and its facts to the address the streamer set, beside the overlay flow, never in front of it. |
| `desktop/src/signin.ts` | Sign in with StreamerSongList (OAuth with PKCE) and its token refresh. |
| `desktop/src/twitch.ts` | Connect Twitch (device code) and reading another channel's About. |
| `desktop/src/model.ts` | The built-in AI's two models (Standard and High quality) and downloading them. |
| `desktop/src/overlay.ts` | Copying the overlay page to the folder OBS loads it from. |
| `desktop/src/updater.ts`, `checks.ts` | Finding, checking and installing a new version; connection checks. |
| `desktop/src/backup.ts` | Automatic and manual backups of settings and facts. |
| `desktop/src/handsfree.ts` | **Hands-free Wrong**: the global key a foot pedal or Stream Deck sends. |
| `desktop/src/reports.ts` | The prefilled GitHub reports, with secrets removed. |
| `desktop/src/plain-errors.ts` | Turns errors into plain words: what happened and what to do. |
| `desktop/src/whats-new.ts` | The "What's new" highlights shown once after an update, from `desktop/renderer/whats-new.json`. |
| `desktop/src/build.ts`, `autostart.ts`, `atomic-write.ts` | Which build this is (release or test build), starting at login on Linux, and crash-safe file writes. |

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
   applies on the next play. With **No facts for this song** or **No facts for
   this artist** on, it stops here (see [Notes, switches and Wrong](#notes-switches-and-wrong)).
   After this step a note in brackets after the artist's name is left out.
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
   and pull out the music-related sections first. Every article is read as it
   was at least 72 hours ago, and only what meets the content standard (see
   [The content standard](#the-content-standard)). A game's track with an
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
   With section-aware selection (on by default; `SECTION_SELECT=off` turns
   it off) the reference is built differently (`selectSections`,
   `sectionExtract`): the lead first, which Wikipedia writes to stand alone,
   then sections that report checkable things (composition, release, charts,
   awards, live performances, cover versions), then style and sound, then the
   rest. Narrative sections (background, influences, development, history,
   production, plot, gameplay) are left out, except a sentence that names the
   song or its composer and is about the music: in judged captions, those
   sections erred three to seven times as often as the lead. Whether an article is
   long enough is still decided on the usual ordering, so the same articles are
   used, and when fewer than 2 usable sentences remain the usual ordering is
   the reference. Verdict sections are filtered too (`verdictFilter`;
   `RECEPTION_FILTER=off` turns it off): reception and review sections keep
   only chart, sales and certification sentences with a number; accolades
   keep those and awards won or nominated for, never a critic's ranking;
   legacy and release sections keep everything but critics' opinions. A small
   model drops the "a reviewer called it", and the opinion reads as fact.
   A music article about a whole series (`isSeriesWide`: a "Music of" page
   named for the series, a first sentence about a series' music, or a section
   per game) is cut to what is about the requested game (`seriesScope`;
   `SERIES_SCOPE=off` turns it off): that game's own section, and elsewhere
   only sentences that name the game itself (not a sequel or the series named
   after it) or the track. With fewer than 2 such sentences, the lead alone.
   Read whole, it filled a first game's track with a sequel's composers.
   Within what section-aware selection keeps, sentences are offered in tiers
   (`tieredExtract`; `TIERED_SELECTION=off` turns it off): 1, the lead; 2,
   clean body sentences that open their paragraph; 3, other clean body
   sentences; 4, the rest, only when tiers 1 to 3 give fewer than 8 usable
   sentences. Clean means under 30 words, no quoted speech of 4 or more words
   (a quoted title is fine) and no reporting verb (said, wrote, according to,
   told, described, called, stated, noted, claimed, recalled, explained). In
   2,898 judged captions, lead sentences erred 4.8% of the time, clean body
   sentences 8.7% and the rest 18.9%. A caption retold from a tier-4 sentence
   that reports what someone said is dropped unless it keeps the speaker's
   name and a reporting verb or quote marks (`keepsAttribution`).
   A game's or another work's article (its lead names it in bold italics)
   leaves out what is about another work (`otherWorkSentences`;
   `WORK_SCOPE=off` turns it off). Wikipedia's style sets the titles of
   games, albums, films and shows in italics, so the article's wikitext
   (fetched once and shared with the infobox facts) tells which titles each
   sentence names (`italicSentences`). Left out: a sentence that names in
   italics a related work (a title sharing a distinctive word with the
   requested one: a sequel, a remake, an edition, another game of the
   series) and not the requested work itself; a sentence about "the remake"
   or "the sequel", or that names the requested work only as "the remake of
   Some Game"; a section headed with another work's title, or "Sequels" or
   "Remakes"; and a sentence right after one of those that goes on with
   "It" or "The game". Kept: a sentence that names the track, the series
   named as a series, unrelated titles (a magazine, the composer's other
   work), albums of the work's own music, and a sentence led by "It" or "The
   game" (the article's own subject). The requested work is the request's
   game or work field, the article's own work and the names its lead sets in
   bold italics (`requestedWork`); a request for an edition keeps that
   edition. Read whole, a game's article filled its tracks with a remake's
   release date and a sequel's credits.
   A cover (`isCoverOf`: the request says "cover", or the song's article
   never names the requested artist in its lead) is read without the
   original's release, charts, sales, video and the band's own doings
   (`originalsRecord`; `COVER_SCOPE=off` turns it off), and of the infobox
   facts only who wrote it is kept: the rest would read as the cover's.
   An infobox that names another artist counts as a cover for its facts.
   The other way around, a song's own article is read without sections on
   one other performer's version or lines on a version's charts
   (`otherVersionsRecord`); a plain "covered by" line stays, since it's true
   of the song. A film that only uses the song's name gets no AI captions,
   and neither does an act that shares the name when MusicBrainz credits the
   song to someone else (`anotherArtist`, comparing the recording's artist
   with the article's Wikidata item; unknown on either side keeps the article).
6. **Write.** The AI rewrites details from the reference as short captions,
   at temperature 0, with the same short system prompt from every provider
   (without one, node-llama-cpp gave the built-in model its own "helpful
   assistant" prompt, which Ollama never sends). Its instructions are laid out as CROSS (Context,
   Role, Objective, Source, Scope); `PROMPT_STYLE=rules` uses the older
   numbered list.
   Before the reference, the CROSS prompt shows worked examples with made-up
   names (`RETELL_EXAMPLES`): a sentence, a wrong retelling and a right one,
   for the three slips the 3B model makes most: dropping who said or thought
   something, keeping an "it" or "these" whose subject was left behind, and
   dropping where, when or on which chart. A model that small copies an
   example better than it applies a rule. It sometimes copies the example
   itself, even onto a real name from the reference, so a line with three
   words in a row from the examples that the reference doesn't have is
   dropped before screening (`copiesExample`).
7. **Screen.** `screenClaims` drops captions the reference doesn't support:
   names, roles ("composed by"), years, consoles, award, chart and sales
   claims, opinions, talk about the video, commentary about the source, length
   and near-repeats of recent facts.
   Words in quotation marks must be in the source exactly and run to twelve
   words at most (`alteredQuote`). A caption opening with "He" or "She" is
   dropped: a viewer can't tell who. Music terms get a few fixed plain words
   (`explainMusicTerms`), never the model's own explanation.
   A caption must also stand alone (`leftBehindReferent`): "for the first of
   these three weeks", "the 1937 recording" with no performer, "total sales"
   with no product and a film nobody names are dropped. So is a year or a
   "with" name taken from another clause of the sentence it retells
   (`mergedClauses`), and a caption whose "it" belongs to a section on another
   recording or a B-side (`otherRecordingSection`).
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
   that names that song ("This theme" and "The symphony" too).
   A bubble stands alone on screen, so it must name what it's about. Dropped
   whatever the source says: a bare "This is ..." or "That year ...", works
   in the plural with no one named ("The operas are spread across his whole
   life"), and a "he", "his" or "her" with no name and no "the narrator"
   or "the singer" for it to stand for (`unresolvedPronoun`). A company's
   business is dropped too, unless the caption is about music
   (`companyHistory`): deals, buyouts, a company renamed, and a console
   announced, unless the caption is led by the requested work.
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
   **Cite the sentence** (`CITE_SENTENCES=on`; off by default, because the
   3B model miscounts the numbers and the screen then dropped about five true
   captions for each wrong one it caught). The reference's sentences are
   numbered for the model (`numberedReference`), and each line it writes starts with the
   number of the one sentence it retells: `4 | caption`. "The sentence it
   retells" above is then that sentence, not a guess by shared words, which
   let merges and swapped subjects through. A line with no number, or one
   the reference doesn't have, is dropped. `citedMismatch` also checks the
   caption against that sentence: every name in it, the two before (for a
   "he") or the title, or the request's artist (for "the band"); every count
   in it and every year in it or next to it; "first" only with a word of
   firsts; "said" or "recalled" only when it gives that person's words; and a
   caption opening on someone other than the sentence's first-named person
   only when the sentence has them doing something ("Gioeli, who was paid
   $3,000, followed Senoue's demos" is no fee for Senoue). It must share a
   quarter of its words with the sentence. `PROMPT_STYLE=rules` doesn't cite.
   A caption opening "I", "We" or "My" is someone's words with no one named
   and reads as the streamer's. Days and months must be in the source too
   (`unsupportedDay`), not just the year.
   `restatesRequest` then drops, on every path except the streamer's own
   typed facts, any caption that is only the title, artist or game plus
   filler ("a song by", "written by", genre). Spares fill the gap.
   A limit the model dropped goes back in (`repairScope`; `SCOPE_REPAIR=off`
   turns it off), from a closed list: one country or region ("in Japan"), a
   named chart, "in its first week", the year "the same year" means, and an
   edition ("the Mega Drive/Genesis version"). Only when the caption retells
   one sentence (half its words, and a number it has, in the same clause as
   the limit), lacks the limit, and the sentence has exactly one of that kind
   with a clear place for it; otherwise the caption is left as written. A
   broad repair broke correct captions before, so this one stays narrow.
   A second closed list puts back, or else drops the caption for, a limit
   on a claim the caption keeps (`repairQualifier`; `QUALIFIER_REPAIR=off`
   turns it off): a limit on a number ("over 200 million", "about",
   "nearly", "an estimated"); "usually", "typically", "mostly", "largely",
   "estimated" and "approximately"; and a release's region when the
   sentence names several ("in North America in October 2014 and in Europe
   in 2015"). Put back where the place is clear (the number, or the word
   right after the limit, appears once in the caption); dropped when the
   caption retells that part but there is no clear place; otherwise left.
   **Choose and order.** `rankFacts` decides which of the captions left, and
   of the song's data facts, are shown, and in what order: at most four (see
   [Which bubbles a song shows](#which-bubbles-a-song-shows)).
8. **Structured facts.** With no article, `wikidata.ts`, then `musicbrainz.ts`,
   fill fixed sentences, with no AI and so no screening but the content standard. When the article is
   the artist's or the game's rather than the song's, structured facts about
   the song go before the AI's captions, and so they do when the article is
   surely the song's own. When the article may be about another
   work, they are all that is shown (see "Is it the requested work?").
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
instant. Only what the stream has shown is saved, in `session.json`, and
only for 6 hours (see above). Several requests for the
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
a Chopin nocturne is a non sequitur.

The streamer's own facts (custom facts and song facts) are the only text shown
without any check, since there's nothing to check them against. That's why
the project ships topic packs only as examples for the command-line version,
the app doesn't offer them at all, and each streamer is responsible for their own. (Structured facts need no
screening beyond the content standard: they're fixed sentences, and only the data in them varies.)

For the same reason, a short result is never padded. Four facts about the
right song beat four plus one unrelated one.

### Which bubbles a song shows

The screens above drop captions their source doesn't support. Some captions
pass every screen and are still wrong more often than the rest, because of
the kind of sentence they retell. `rankFacts` (`fact-ranking.ts`,
`SOURCE_RISK=off` skips it) holds those back, then puts the most interesting
first. Every signal is a text comparison between a caption and its source
sentence (the one it cites, or the one sharing at least half its words). No
model is asked.

1. **Unsure work match: no captions** (see "Is it the requested work?").
2. **Held back** (`sourceRisk`): a caption whose source sentence has a
   reporting verb ("said", "according to", "described"), a quote of four or
   more words (a quoted title in Title Case doesn't count), 30 or more words
   outside the lead, or a hedge ("usually", "about", "may") the caption lost;
   or a caption keeping less than half of a sentence outside the lead (or
   matching no sentence at all).
3. **Floor of three.** With fewer than three bubbles left, held-back captions
   come back, fewest flags first, after the others. Never one from step 1.
4. **Interest** (`interest`): a number, an age or a place you can picture
   ("in one afternoon", "at 16", "in a stairwell") and how it was made (a
   sample, a borrowed instrument, what inspired it) count +2; a first or a
   record +1, only when the source sentence says the same word (one it
   doesn't say counts -2: a caption never upgrades a claim); a relatable fact
   about a person (an age, a hometown, teaching themselves) +1; what an artist
   gave (see "Facts about the good an artist does") +2; awards,
   charts, sales and release details -1. Highest first; among equals, data
   facts and lead captions, then the writer's order. On an artist's or a
   game's article the song's own data facts still lead.
5. **At most four**, and no two of the same kind in a row when another kind
   is left.

Why these: on judged runs, captions from the lead were about 5% wrong and
those from the body about 13%, and release and sales sentences were both the
dullest and the most often wrong, so accuracy and fun mostly pull the same way.

### The credit bubble

One extra bubble tells viewers where the facts come from and that they may be
wrong ("Facts from Wikipedia, Wikidata and MusicBrainz, retold by AI. Spot a
mistake? Let the streamer know."; `credit.ts`, issue #278, `CREDIT_BUBBLE=off`
hides it). It goes out before the first song's facts after BubbleFacts starts,
then with about every 5th song that has facts (`CreditCounter`), and the
song's facts start after it. A song with no facts, bubbles paused, no overlay
connected, or a test bubble in the last 20 seconds doesn't use up a turn. The
credit is only sent to the overlay, never put in the song's record, so **Wrong**,
the dashboard and the shown log never see it, and an overlay that reloads
mid-song isn't given it again. The count is kept in `session.json`, so a
restart in the middle of a stream carries on.

### The content standard

"About the music. Safe for any stream." A bubble never says what a polite
chatter couldn't post in a family-friendly music stream, in line with
Twitch, YouTube and Kick community rules (issue #242). Twitch holds the
streamer responsible for everything on stream, and the riskiest true
sentence in an artist's article is about a person, not the music: an
arrest, an illness, a divorce, how someone died.

`content-standard.ts` holds seven word lists (crime or lawsuits, drugs or
addiction, sexual content, private life, health, how someone died, and who
someone is: ethnicity or an Indigenous nation, race, religion, sexuality,
gender identity), each with a comment naming the platform rules it follows. Matching is whole words
or phrases, any case. It runs in three places:

1. **The article, before anything reads it.** `wikiExtract` leaves out whole
   sections with private headings ("Personal life", "Legal issues",
   "Controversies", "Health", "Death and legacy", but not "Death Mountain" or
   a game's "Health, lives, and power-ups") and every other sentence a list
   matches. A heading with a year is a period of a career ("2011–2018: ...,
   tour, and legal troubles"), filtered sentence by sentence. A plain death year stays: "died
   in 2004" is on no list, "died of" and "died in a" are.
2. **Every caption.** `screenClaims` drops a caption a list matches, whatever
   its reference says, so a retelling can't add what its source didn't
   ("charged" told as "convicted": both words are on the list). The log names
   the reason only, never the caption, so logs and reports can't spread it.
3. **Every fact from data**, from Wikidata and MusicBrainz, the same way.

A listed word inside a name or a title is the name: "Smooth Criminal", a
band called "The Crime Lords", a quoted "Heroin", the song's own title and the
artist. A capitalized word next to another capitalized word, or right after
a quotation mark, counts as a name; an all-capitals word ("LSD") doesn't.

The identity list has its own name rule: a word right after it about the music
keeps it ("Christian rock", "Inuit throat singing"), and a word for a people
next to it is not a name ("Jewish American"). Where someone is from stays
("a Canadian singer"). Only category words are listed, never peoples. The one
exception is the artist's own words: a sentence where they describe themselves
("has described herself as", "said he identifies as") stays in the reference,
and a caption from it is kept only with the artist's name and those words
(`selfDescribedIdentity`). Data facts get no exception.

There is no setting: the standard is always on for sourced captions. The
streamer's own facts are theirs and are never checked.

### Facts about the good an artist does

Bubbles celebrate the artist: benefit shows and charity, disaster relief and
money raised, movements, music education, mentoring,
preserving music, community work, roles such as goodwill ambassador or union
officer, musicians' rights, the environment, open sharing, and public honors.
There is no setting. At most one goes with a song. It never takes a song fact's
place: it needs a free slot among the data facts (`rankedData`), and on a song
with an article it sits beyond the data facts' room, so at worst it takes the
last caption's bubble. Within the bubbles shown, `rankFacts` orders it like any
other.

**Sources** (`artist-good.ts`, `artistGoodFromEntity` in `wikidata.ts`):

- **Wikidata**, one template per statement: movement (P135), a cause position (P39), a
  benefit show (P1344), a musicians' body (P463), students (P802) and up to two
  lifetime honors (P166). Competitive categories ("Grammy Award for Best ...")
  are left out: they are the dull ones and a song's own item already has them.
- **The artist's Wikipedia article**: one sentence, as written, no AI, and only
  if it has the shape of a checkable act (`ACTS`): founded an organization,
  donated to, performed at or headlined a benefit, was named or appointed to a
  role, taught, gave a masterclass, co-founded, led or took part in a named
  music or arts movement ("the Example art movement", "Example, a musical movement"; a
  described "consciousness movement" and any other movement fail, since no list can
  name every political one), received an honor in an honors section, or a
  thing was named after them. This is an allow-list because block-lists leak:
  "supported", "opposed", "backed", "lobbied" and "has been involved in" say
  where someone stands on any subject, and fail by not matching. Its subject must
  plainly be the artist. A leading "She" becomes the artist's name, only at the
  start of a paragraph or right after a sentence about them. A closing clause
  may be cut to fit a bubble; nothing is added.

**Same names.** The artist comes from the surely matched article, never from a
name search: that article's own item when it is the performer, else the
performer (P175) the song's item names (`sureArtist`). No sure match, no fact.

**Left out as noise:** who an artist influenced (an opinion, unless someone says
so by name), who founded what by Wikidata's "founded by" and things "named
after" someone (both need a full-text search Wikidata rate-limits hard), and
prison shows (the content standard's crime list blocks them, and stays as it is).

**Neutral wording** (`neutral-wording.ts`, every rule in one file). Advocacy and
politics are tied together, so the line is drawn by how a fact is told, the way
plain news does, not by topic:

- State the public act someone can check, not its merit: what the artist did and
  for whom. "Performed at a benefit for X", "co-founded Y", "named a goodwill
  ambassador".
- No judging words ("champion of", "stood up to", "controversial"), no claim that
  a cause is right or wrong, and no motive ("because", "commitment to").
- Out whatever the wording: candidates, parties, elections, endorsements, and
  whatever reads as taking a side in a contested fight. Naming the side counts,
  so a petition, an open letter or a boycott stays out too, except about
  musicians' own pay and rights.
- For someone living, no sums of money, and no undated "is a patron": "became a
  patron in 1999" is an act, with a date to check it by.

Why: a viewer of any politics should enjoy these bubbles, and a bubble naming a
side makes the streamer look as if they took it. The content standard comes
first and isn't loosened: a cause on one of its lists stays out, and for these
facts an identity word counts even inside a name (`namesIdentity`). Every AI
caption is also screened for the judging words, and one written from an artist's
article for motives too (`loadedCaption`). Captions don't get the wider list for
these facts: "causes" is everyday in a sentence about a song. The prompt
asks for the act when the reference is an artist's article (`NEUTRAL_PROMPT`).
Word lists only, like the content standard: a miss keeps a fact off the stream.

### Notes, switches and Wrong

Issue #262's rules, for when a fact must not be shown at all:

- **A note after the artist's name** ("Some Band (note)") is the streamer's.
  `generateRest` leaves it out once (`withoutArtistNote` in `text.ts`), right
  after the streamer's own song facts are matched (a note may be how they wrote
  an alias). Nothing after that sees it: no search, no prompt, no fact, no log
  line, no report. The overlay's banner and the dashboard show the song as
  listed. `songKey` leaves it out too, and Wrong marks saved with one are still
  found. A handle ("Jane (@janeplayskeys)") is not a note.
- **Who asked or paid for a song** ("Some Band, Commissioned by Name", "Some
  Song (requested by Name)", "Some Band, for Name") is a viewer's name, so it
  goes before anything else sees the song: `toSong` drops it from the title
  and the artist (`withoutRequestCredit` in `text.ts`), `withoutArtistNote`
  drops it with the note, and `fetchGrounding` drops it again at the lookup.
  It is never searched, prompted, shown or logged. "For" counts only after a
  separator in the artist field: "Tears for Fears" stays whole.
- **No facts for this song** and **No facts for this artist** (`noFacts`,
  `noArtistFacts` in `song-facts.json`) leave only the streamer's own facts:
  their facts for the song and their tagged custom facts. `generateFacts`
  checks them before its cache, so they apply at once. The artist switch
  matches the name without its note, and the lead of "A feat. B". On the song
  on now, the found bubbles come off (`remove_fact`), and a restart keeps them
  off (`allowedFacts`). They're in the editor and, one click each, under
  Earlier songs.
- **Facts took** on the dashboard (`aiTimeFor`, `/health`) is how long the song
  on now waited for facts when the AI wrote for it, from asking to having them,
  so waiting its turn behind another song counts. Late bubbles start here. A
  song the AI didn't write for, or a play from the cache, shows nothing.
- **Tracks that aren't music** (`not-music.ts`) go the same way with no switch:
  commercials, station idents and jingles get no Now Playing bubble and only
  the streamer's own facts. A player reports them like songs and only their
  words tell them apart, so the rule is narrow: phrases like "fake commercial"
  or "station ID", a tag alone in brackets like "(Jingle)", an artist field
  like "Commercials", or, with no artist, a title ending in such a word. A
  commercial with none of these words still looks like a song; a real song
  losing its facts is the worse mistake, so the rule stays narrow.
- **Wrong on the song on now** takes off the bubble and the rest of this play's
  bubbles from the source it blocks (`pulledWithWrong`): the same article, or
  Wikidata and MusicBrainz together.
- **Logs give the reason a fact was dropped, never its words.** Logs go into
  problem reports.

BubbleFacts can't know a community's protocols. These rules lower the chance
it repeats what it shouldn't; the switches are the streamer's own call.

**Only settled versions.** Most vandalism is reverted within hours, so an
article edited in the last 72 hours is read as it was before: the newest
version at least 72 hours old (`rvstart` and `rvdir=older` on the revisions
API), parsed to HTML and turned into plain text (`wiki-html.ts`). Older
versions are remembered by revision number like recent articles. An article
younger than that is skipped. When the older version can't be read,
Wikipedia is skipped for the whole song this time (`fetchGrounding`): data
facts still show, and the song is looked up again later.

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

- **Installments must name the track as music.** A game match that extends
  the name ("Final Fantasy" to "Final Fantasy VII", "Undertale" to "Undertale
  Yellow") is used only if a sentence about music names the track
  (`namesPiece`), and isn't shared with the series' other tracks. The name
  alone isn't enough: a newer game's whip is also called the "Vampire
  Killer", and a game's director "preferred working alone".
- **One of several same-name works needs the track.** "Some Game (1984 video
  game)", when the search also finds the 1987 one or the name's own page and
  the request gives no year (`oneOfSeveral`), comes after the others. Up to
  three of them are read, and the one whose music names the track is taken;
  when none does, a dated one is never taken.
- **A game's track comes from the game, not a film of its name.** When the
  best match for a game is a film's, a show's or a book's page ("Sonic the
  Hedgehog 2 (film)" outranked the game in the search) and it never names the
  track as music, the game's own page is taken instead: bare or "(video
  game)" (`gameInsteadOfScreen`), from the search or, when the search didn't
  list it, from Wikipedia's pages of that name, and only if its brackets or
  its opening say it's a game. Another game of the name ("(8-bit video game)") never stands in.
  With no such page the film stays, and the work match still calls it unsure.
- **Performers aren't games.** When the upload is a music video
  (`song.performer`), band and singer articles match, game, film and TV
  articles don't, the search asks for "`<name>` band", and an article with no
  label in brackets must open like one about a performer ("Milestone" the
  road marker doesn't).
- **A show as the artist gives its music, never just its name.** When the
  artist field is a film's or a show's name and no performer has that name
  on Wikipedia, the show's article is skipped unless it names the track. Its
  own music article ("Music of Some Show", "Some Show (soundtrack)") is taken
  only when its text or one of its track listings names the track
  (`listingMusicArticle`). A performer's article under the name still wins,
  and one taken in place of the search's page ("Some Name" to "Aurelio Some
  Name") is never read as a longer-named installment.
- **"Some Name Theme" can be the music of "Some Name".** Only when every
  reading and MusicBrainz's link missed, the name has two words or more, and
  no performer has the artist's name (`themeGrounding`): the article under
  exactly that name, if it isn't a person's (no life dates in its lead, not a
  human on Wikidata) and has a section on its own music ("Song", "Music",
  "Theme song") with a music word in its lead. Only its lead and those
  sections are read, so facts come from the work and its music. The artist
  may be an arranger the article never names.
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
- **A list's own notes**, tried after the song as listed (`lookupForm`):
  brackets after the artist, a year or "feat." tag in the title, a track
  number before it ("14. Some Song", never "1979" or "7 AM"), an arranger
  after it ("Some Song arr. Some Pianist"), and an arranger's mark between
  names ("Some Pianist (arr) Some Composer" is the composer's piece).
- **The work a song is from** in the title ("Some Song (from Some Show)",
  "Some Song from Some Long Show"): the show is the work, as a game in the
  artist field is, and only the song's own article counts (`workFromTitle`).
  This reading goes first: the usual one would take the composer's article
  before trying it.
  Without brackets the work needs two capitalized words, so "Pennies from
  Heaven" stays whole; "Theme from Some Show" is left to the theme rule.
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
- **A performer whose name is also a film or a book** ("Some Band
  (British)", or a band named like a fairy tale): when the subject's article
  a search finds is a film, a show, a book, a play or a tale (`isNonMusicWork`),
  or the artist reads as a performer, one title lookup with Wikipedia's short
  descriptions (`performerPages`) looks for the song's own article ("<Title>
  (<Artist> song)", or "<Title> (song)" when its description names the
  artist, never a redirect to the album) and the performer's ("(band)",
  "(singer)" and so on). The song's article is taken first; a film whose lead
  doesn't name the band as a band, and which never names the requested piece,
  gives way to the performer's article or is skipped. A concert film, a
  documentary or a live video (`isConcertFilm`) names the band throughout,
  so only its lead naming the track keeps it; one named for the song is
  skipped as the song's own article. Any subject article that never names
  the piece as music is questioned too, since a one-word band name reads as
  a game's: "Heart" found *Heart of Darkness*, a game, and "Muse" Elton
  John's *The Muse* soundtrack. The song's own article is then taken
  wherever it's found (the performer's own article stays when the song's
  is too short to write from), and any other page gives way to a
  performer's article under the name, never to itself. A game's article without such a song
  stays: game music lists put the game in the artist field, and a band may
  share a game's name. A city's, a country's, a region's or a sports team's
  article is never a song's reference either: when the article doesn't open
  as a piece, a performer or a game, its Wikidata item's classes are read
  (`placeOrTeam`, by class label, since places come in national classes like
  "municipality of Brazil"; a fictional place stays, as a game's world). The
  item is read once and kept for `articleItem`.
- **A game in the title, possessive** ("Yoshi's Story: On the Beach" from
  "Yoshi"): the longer name is the game, as for "Super Mario 64: ..." from
  "Super Mario".
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

When every reading still misses, MusicBrainz's own link is followed
(`linkedGrounding` in `musicbrainz.ts`, issue #245; `MB_LINK=off` skips it).
MusicBrainz is searched for the recording, forgiving a typo or two; a result
counts with a score of at least 80, a title within a third of the edits of
the typed one, and a credit naming the typed artist, a respelling of it, or
what its initials stand for ("CCR"). Then only the English article named by
the Wikidata link of the recording, its work, or else its artist is read.
Never a search on what MusicBrainz returns: "Halocene" searched on Wikipedia
finds "Holocene (song)". The page must still pass a gate:

- A song's page must have the request's title, open as a piece of music
  (not an album, a film or a show), and name the artist in its intro.
- A song Wikidata credits only to someone else is the original of a cover.
  Its intro must name that performer, and the reference opens with "originally
  by" them, so no caption credits it to the artist on the list.
- An artist's page must open as a band's, singer's or musician's, under the
  typed name, a close respelling, or its initials.
- A respelled credit is never followed when MusicBrainz also knows an artist
  under the typed spelling: that one is someone else.

The cost is three to seven MusicBrainz requests, one a second, only for a song
nothing else found.

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

**Classical pieces** (issue #260; `CLASSICAL_LOOKUP=off` skips this). A
search for "Moonlight Sonata" or "Nocturne Op. 9 No. 2" finds a film called
"Beethoven", another prelude, or nothing: the article is filed under "Piano
Sonata No. 14 (Beethoven)". So before the usual readings, the artist field is
looked up on Wikidata, and when it is a composer or a classical performer, the
work is found there:

- The title is read apart first (`parseClassicalTitle`): catalog numbers (Op.,
  BWV, K./KV, D., Hob., RV, HWV, S., WoO, L.), "No.", the key however it is
  written (E-flat, Eb, E♭, C#), and a movement ("3rd Movement", "2nd mvt",
  "I. Allegro"), kept as a hint for which section to read first, never
  searched. A bare "Prelude" or "Nocturne" names no one work and is skipped.
  One bracket may hold it all, "(op. 3, no. 1, "Elegie")": the nickname left
  once the numbers are out is another name for the piece, without its quotes,
  and "from Some Suite" in it is the set the piece is from, not a name for it.
- A composer's works are searched with the composer (P86), so a nickname in
  the item's aliases or P1449 finds the work. Only an item whose names hold the
  request's words, with every number it gives and the same key, counts: the
  Prelude in G minor is not the Prelude in C-sharp minor. A catalog code on the
  item (P528) is enough on its own ("BWV 1007 Prelude": "Prelude" is a movement).
- A performer in the artist field (a pianist, an orchestra; never a pop act)
  has the piece looked up by its title alone, and the reference says who wrote
  it, so no caption calls the pianist the composer. So does a composer of our
  time playing an older piece.
- A piece with no article of its own is read from the work it is part of
  (P361), or that lists it as a part (P527), or the set it is numbered in
  ("Two Arabesques" for "Arabesque No. 1"): "Clair de lune" in "Suite
  bergamasque", "Dance of the Sugar Plum Fairy" in "The Nutcracker". The
  section about the piece leads (by its name, or by its number in a set: "No.
  2 in E♭ major"), and `workMatchConfidence` is `sure` only when there is one.
  A whole piece and one of its movements are cached apart.
- A classical request is never read from a film's, a show's or a book's
  article, a person who isn't a musician, or a piece in another key, by any
  reading (`notForAPiece`).

Wikidata's full-text search is rate-limited hard, so its requests are a
second apart, and a throttled lookup is never cached: the usual lookup runs
instead, and the work is tried again next time. The cost is two requests per
artist per session, and two to four more for a classical request.

**Is it the requested work?** On songs no fix had seen, almost half the wrong
bubbles came from an article about another work: a sequel or an edition, a
series, a film named like the band, the original of a cover. Screening can't
see that, since the captions match their reference. So the found article gets
a confidence (`workMatchConfidence`, issue #255; `ABSTAIN=off` skips it), and
an `unsure` one gets no AI captions: only the song's Wikidata or MusicBrainz
facts, the streamer's own facts, and, when that leaves fewer than two, up to
two Wikidata facts about the artist or the game (`artistFacts`: an item named
exactly so, described as a performer or one video game, never a series). The
log says why (`[Grounding] unsure: ...`). Unsure is:

- the original of a cover (MusicBrainz's note), or MusicBrainz's link to the artist;
- an album's article for a song, or another song's article;
- a song's article that doesn't name the artist in its first three sentences
  (only the first, or the title's brackets, for a one-word title: "Cherry" by
  one singer is often another's);
- a game's parent article for an edition or epilogue ("Some Game: An Epilogue"
  finding "Some Game"), unless its first sentence names the rest;
- a series' article for a track it never names as music (a series-wide
  music article still counts as sure: its facts are about the music). Only
  a sentence about music goes under "About this piece" too: "Castlevania"
  names the "Vampire Killer" whip and the MSX game *Vampire Killer*;
- a film's, a show's or a book's article that never names the song, or one
  named after the artist ("Some Band: Live");
- the artist's article that never names the song, found only after dropping a
  note ("Some Singer (Tribute)", "Song (Someone's cover)").

A `sure` article is then checked against Wikipedia's own page summary
(`summaryGate`, the REST `page/summary` endpoint page previews use, cached
like the article; if it can't be read, nothing changes). Unsure is also:

- a disambiguation page, or any page the summary doesn't call a standard
  article;
- a page named like the song that the summary describes as a film, a show,
  a book, a game, an album or a person ("Some Song (film)": the song's own
  article by its title, as far as the rules above can tell);
- a film's, a show's, a book's or a game's article that isn't the request's
  own work (its game or artist field) and never names the song;
- a person's or a band's article for a song that has an article of its own
  ("Song (Some Band song)", "Song (song)" or "Song", described as a song and
  naming the artist).

The summary's description comes from the current version, not the 72-hour
one, but it can only take captions away, never add any.

A game's own article and its music article stay `sure` for its tracks: they
are what a game's music is written about. So does an artist's article found
under the name as typed, the fallback it has always been. Measured once on 80
songs no fix had seen: 12 unsure (15%), five of the nine songs with captions
about the wrong work among them, and about 8% fewer bubbles per song.

### Why is the game read from the artist field?

Game-music song lists usually put the track in the title and the game in the
artist field. `resolveGameAndTrack` is the one place that handles this. If
every song suddenly gets generic facts, check it first.

An artist that is a streamer's handle (`@name`, `Name (@name)`) is another
music content creator's piece: nothing is looked up, and the streamer's own facts are used.

### How do I see what a stream showed?

Each fact sent to the overlay is logged as `[Shown] "Song" (source): text`,
next to the `[Screen] DROP` lines for what was held back (the reason only,
never the words). It's logged where
the facts go out (`broadcast` in `server.ts` after the pause check, and an
overlay's catch-up), not where they're written, so a skipped, paused or
superseded song's facts aren't in it. Each fact is logged once per play of a
song, however many overlays get it (`shown-log.ts`); nothing is logged while
no overlay is connected, and the first one to connect gets them, logged then.

The same facts go into `aired-facts.json` in the data folder
(`aired-facts.ts`): the song, the fact, its source and link, and when it
went out, newest 500, written whole each time like `session.json`. The app
reads it through `/control/aired` (or the file, when the server isn't
running) so reports don't depend on the log: a **Wrong** report gets the
exact fact with its source and time, plus the other facts from that play of
the song, and **Report a problem** gets the latest ten after the log. Secrets
are removed from them like the log, and when the web address is too long the
log is trimmed before them.

### What gets remembered between songs?

- What was shown is saved to `session.json` in the data folder: after a
  restart mid-song, only the bubbles still to come are sent, and earlier
  songs' facts aren't repeated. An overlay that connects or reloads mid-song
  (a second output, or a scene switch that reloads the source) gets the song's
  bubbles that haven't finished showing, from the server's record of what
  went out (`catchUpFacts` in `session.ts`): the one on screen comes back for
  the time it has left, unless a later bubble took its spot, and the rest keep
  the other overlays' schedule. The credit bubble isn't in that record, so it
  never comes back. A fact taken off with
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
the server after two minutes of `degraded`, never for `unauthorized`. When
`degraded` only means fetches are failing (an internet or song-service
outage), it restarts only if the polling loop itself has stopped: `/health`
reports `lastPollAttemptAgeMs` (failed fetches keep it small) and the app
allows three poll intervals, at least two minutes. A restart can't bring the
internet back, and it reloads the AI and blanks the overlay.

**StreamerSongList** (`songlist-client.ts`):

- REST `GET /queue`: the `playing` slot is what's on now; the first item in
  `items` is the *next* song and is only a fallback.
- Centrifugo (`centrifugo-client.ts`) on `streamer:<id>` and
  `streamer:<id>-queue`. The channels go in the connect request's `subs`;
  Centrifugo ignores fields it doesn't know, so the `channels` field 2.0 sent
  subscribed nothing and every change waited for the 60 s poll. The events
  count as connected only when the reply's `subs` lists a channel. Every
  publication, whatever its data, and every reconnect does the same thing:
  one debounced re-read of the queue. Event types are never inspected, so a
  missed or renamed event costs at most one poll.
- Polls every `SSL_POLL_INTERVAL_MS` (15 s), with events connected or not:
  events make a change show at once, and the poll caps the wait when one is
  lost. An update during a read triggers one more read afterward.
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

**Now playing file** (`now-playing-file.ts`), `SONG_SOURCE=nowplaying`, for
apps that write the playing song into one text file:

- Polled every 2 s (`fs.stat`, then the first 4 KB), not watched: file events
  are unreliable on synced folders and other drives, and one small file is cheap.
- The file is the only word on what's playing, so the rules lean toward
  nothing. Missing, empty, a line with no letters or digits (" - " from an
  app's template), or a file not rewritten for 15 minutes (`STALE_AFTER_MS`:
  left over from an earlier stream, or a player that stopped without
  clearing it) all mean no song. An unreadable file ends the song too.
- A reading counts once two checks in a row agree, so an app caught mid-rewrite
  (empty for a moment) doesn't restart the bubbles. Identity is the line
  alone: a rewrite of the same line is the same song.
- `artist-title` splits at the first spaced dash, so "Artist - Song - Part 2"
  keeps its title. A line without one is all title, with the artist
  `Unknown`, as with `title`.
- The entry has no requester, length, play count or note, as with a
  StreamElements request missing them. `lastSuccessfulFetchAgeMs()` counts a
  missing file as checked: the app may not have started, and a restart
  wouldn't help. Logs name the file, never its folder, which holds the
  computer's user name.
- Presets (`NOW_PLAYING_PRESETS` in `config.ts`) give the folder; a name or
  relative `NOW_PLAYING_FILE` is found in it. Streamling's is
  `Documents\streamling\livetext\nowplaying-minimal.txt`, the file its author
  recommends: one "Artist - Song" line, though it can also be a YouTube
  title ("Song - Official Music Video"), so the preset reads it as one
  (`youtube-title`), as Nightbot's is read.
- Preset folders are looked up by `presetFolder` (`now-playing-folder.ts`):
  `~/Documents/<folder>` first, then `Documents/<folder>` in each of the
  `OneDrive`, `OneDriveConsumer` and `OneDriveCommercial` folders the computer
  names (Windows often moves Documents into OneDrive). If none exists yet, the
  usual path is used. The app has the same rule in `desktop/src/now-playing-folder.ts`
  to show the folder actually read; keep the two alike.
- Nightbot (`nightbot` preset): its docs name the folder (`Documents/Nightbot`,
  Windows and Mac) but neither the file nor the line, which is customizable,
  and its songs are YouTube videos. So the preset has no file: each check
  takes the most recently changed `.txt` in the folder (`newestTextFile`;
  missing folder or no `.txt` is no song), and the `youtube-title` format
  runs the line through `parseVideoTitle`. A trailing "requested by ...",
  "added by ..." or "requester: ..." is dropped first, and nothing else is
  guessed. Not yet tried against a real install.
- A line with no artist (a video titled just "Song - Official Music Video",
  or a bare title) is marked `titleOnly`. Before its lookup, `artistByTitle`
  (`musicbrainz.ts`) searches MusicBrainz for recordings of that exact title
  (case, accents and punctuation folded). When every one is by the same
  artist, the song is looked up with that artist and marked
  `artistFromTitle`, which makes its work match unsure, so only facts from
  data show. Two or more artists, a placeholder credit ("[unknown]"), or more
  recordings than one search returns (100) give no artist: common titles
  ("Alone") never resolve. Results are cached like the other MusicBrainz
  lookups. Streamling's public pages name only `nowplaying-minimal.txt` and
  its ASCII twin `nowplaying-minimal-ascii7.txt` in `livetext`, the same
  line, so there's no channel or artist file to read beside it.

**YouTube titles** (`youtube-title.ts`). StreamElements only knows each
request's YouTube title and channel. `parseVideoTitle(title, channel)`:

1. drops hashtags and label brackets ("(Official Video)", "[4K]", "ft. X",
   also in Spanish, Portuguese, French and German), labels that name the
   artist or the song too ("(Some Band Official Music Video)"), variant
   brackets ("(Live)", "(Remix)"), and a later segment that names where it was
   performed, not the song (a late-night show, "Tiny Desk", "SNL", "Live
   on/at/from ..."; `PERFORMANCE_SEGMENT`, whole segments only, so "Tonight"
   and "Live Forever" stay songs);
2. reads the work from "(From "Frozen")", "(... OST)", "| Game of Thrones" or a
   "Series: Subtitle" bracket, and the artist from "(by X)";
3. splits "Artist - Song" on a spaced dash, `~`, ` / ` or ` // ` (never
   "AC/DC"), and swaps the sides only on a clear sign: the channel or its
   initials ("SNL") name the right side, or only the right side is a
   soundtrack or a "Series: Subtitle". With no sign either way, and no
   official channel, it marks the order `orderUnsure`; the StreamElements and
   now playing file sources then ask MusicBrainz once (`settleTitleOrder`:
   one search for both orders, cached, through the paced queue, waiting at
   most 1.5 s before the song change) and turn the reading round only when
   MusicBrainz has the other order's recording and not this one's;
4. otherwise tries `Artist "Song"`, `X's "Song"`, "A x B" and, when nothing
   else named the artist, `Artist_Song` (`underscoreSplit`: one underscore,
   words on both sides, neither starting in lowercase; never a filename, a
   slug, a username, or a "requested by dana_k" note);
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

Both need no AI and no screening beyond the content standard, and are skipped
for a song whose structured facts were marked **Wrong**. They are the facts
when there's no article about the song itself, and they also go out ahead of
the AI's captions when the article is about the artist or game, or surely the
song's own (see "Data first, captions later" below).

- **Wikidata** (`wikidata.ts`). `wbsearchentities` in the title's own
  language (`searchLanguages`: Japanese, Korean or Russian when the title is in
  that script, else English), so 紅蓮華 finds LiSA's song. A title of Han
  characters alone tries Japanese, then Chinese, then English, and stops at
  the first search that finds a song. `pickSong` takes
  only an item whose label is the title and whose description is a music
  item naming the artist or game ("2021 single by Lil Nas X"), so a
  same-named song by someone else never matches. Deprecated statements are
  ignored; preferred ones win (`rankedClaims`). Statements used: composer,
  lyricist, year, album or work, producer, up to two awards, charts, what the
  song is based on, up to two derivative works, the single before and after
  (only for an item described as a single), the language of the lyrics (not
  when it is only English) and the date of the first performance. Other
  works are named by label alone, never with an artist, so a cover or a
  derivative work is never credited to the requested artist; a work with the
  song's own name is left out.
- **One bubble for the basics** (`data-facts.ts`, issue #256). On a busy PC
  the instant data facts can be all a viewer sees, so a song's year and album
  read as one bubble ("came out in 2021 and is on the album X"; "and is on",
  not "on", because an earlier single may not be listed) and an artist's
  origin, genres and labels pack into as few bubbles as fit. Values are
  placed as the source gives them. A combination over `MAX_FACT_CHARS` falls
  back to separate facts; one known value stays a single fact.
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
  album), or when the search didn't return every recording: the earliest of
  25 may be a later re-recording (Heart's "Alone" on a 2010 EP). A
  recording credited to the game's own name, on an album of that name, is
  the game's soundtrack: no year or album, as for any game's track. An "additional" composer, such as a fanfare quoted in another
  composer's cue, isn't named.
- **The article's own item** (`articleItem` in `wikidata.ts`, issue #256).
  With no AI, the article is still looked up, alongside the data. Wikidata's
  and MusicBrainz's searches miss a typo Wikipedia's search forgives
  ("Harbr Lights (2004)"). So when the lookup surely matches an article
  (`workMatchConfidence` sure and `summaryGate` clear) and Wikidata's search
  found nothing, the page's own item is read: one request by page title, one
  for the labels, cached like the others. MusicBrainz's facts never wait for
  it: the item adds to them only when it is already in (and is ready for the
  next play); a song MusicBrainz knows nothing about waits for it. A song, single or musical work (by
  P31) gives its year (a date at year precision or finer, and none when the
  description dates it another year, as for a later single of an older song),
  the album it's part of (only an item described as an album, EP, soundtrack
  or mixtape) and up to two genres, under the item's own name. When it names
  performers and none is the requested artist, it is another performer's
  version and gives nothing. A band or a musician gives the artist facts
  above, when its name is the artist's. Those leave out a birth or formation
  year Wikidata gives two ways, or a group's "inception" that its "work
  period start" contradicts (a reunion year), and say "the" before a country
  that takes it ("formed in the United States"). Anything else (an album, a film, a
  game) gives nothing, and so does an unsure match. Values MusicBrainz
  already gives for the song are left out. When the two years differ,
  MusicBrainz's stands when it is the earlier (it leaves out reissues,
  compilations and live albums); when Wikidata's is earlier, neither is shown.
- **Data first, captions later** (issue #256). With AI on, the facts from
  data are looked up alongside the AI: for an article about the artist or
  game, as before, and now also for an article surely about the song itself
  (its item too). When they're ready before the AI, they go to the overlay at
  once (`generateFacts`'s `onEarly`), at most one fewer than the song's
  bubbles, so a caption has room, and never more than two
  (`MAX_DATA_FACTS`). The article's infobox facts are not sent early: they
  fill any data-fact slot left after the AI finishes, unless a caption
  already says them. When the AI finishes, its captions follow
  them in the song's record (`withLaterFacts`): each after the last fact
  sent, never in the past, never one already sent or taken off with
  **Wrong**, and a caption too like a fact already shown is dropped by the
  usual repeat check. They go out as `facts_ready` with `keep: true`: the
  overlay leaves the bubble on screen and replaces only the turns still to
  come. An older overlay ignores `keep` and starts over with the same list,
  as after a reconnect. If the AI fails, the facts from data stand; if the
  song changes first, the captions are dropped. A song with the streamer's
  tagged facts mixed in still goes out once, since those are re-spaced at
  the end.
- **Data facts are the safe layer** (issue #256). Data facts are
  dropped rather than risked. On a benchmark of unseen songs, about 6% were wrong or misleading,
  for four reasons, each now checked:
  - *Another work's infobox.* The infobox is used only when it describes the
    requested work (`boxMisfit` in `infobox.ts`): a song's infobox only under
    the requested title; a game's only when its name is the artist field's
    game, or ends with it, and never when MusicBrainz has the song by a
    performer of that name (a band and a game called the same); an album's
    only when its name or artist names the requested game or artist (not
    another album in a series' music article). A remake under its own name
    fails the name check. The article's own item is likewise used only when
    its label is the requested title, and `artistFacts` takes nothing when two
    performers or games share the name.
  - *A credit cut to one name.* Wikidata's song items often list one of
    several writers or producers. When the item has an English article, its
    writers and producers are told only when the article's song infobox lists
    the same people (`sameCredits`); otherwise they are left out. Every source
    names every credited person, or none when the list is too long for a
    bubble, never the first few.
  - *A genre list told as the genre.* The infobox's genres read "The genres
    of X include A, B and C", up to three, never "usually filed under".
  - *Another year.* A song item's year stands only when the item's
    description gives no other year (anywhere, as in "... released in 1999")
    and the song infobox of its article agrees, and never when it is later
    than the year of the album that infobox links to (`albumYear`): a song
    first out on an album and released as a single later came out with the
    album. That holds for the infobox's own year and, through the article's
    item, for MusicBrainz's. An infobox that names another
    artist (a cover's page redirecting to the original's article) isn't used
    for either check. A bare year in a request ("Some Song (1999)") is not
    used: on a 300-song list it was often another version's year, so it would
    have dropped correct years.
  - *Another place.* An artist's birthplace or origin from the article's own
    item, and its birth or formation year, are told only when the article's infobox
    (birth place or origin; birth date or first year active), if
    it has one, gives the same (`boxBacksPlace`, `boxBacksYear`).

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
        → song on now: overlay gets remove_fact, even mid-bubble, for it and the rest of
          this play's bubbles from the same source; session.json drops them
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
`toSong` in `song-mapping.ts` (`cleanRequestText`): one line, at most 200
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
| `/control/facts-off` | **No facts for this song** and **No facts for this artist**, in the editor and one click each under **Earlier songs**. Saves the switch, forgets the song's cached facts and, for the song on now, takes the found bubbles off (the streamer's own stay). |
| `/control/songs/search` | **Add facts for another song**: songs on the StreamerSongList list whose title or artist contains every word typed (case and accents ignored), titles starting with it first, at most 8 by default. Searches the copy read at start (`learnListFormat` keeps id, title and artist), so a song added to the list later shows after a restart; a read that failed is retried on a search, at most once a minute. Picking one saves the facts with its song ID. `available: false` with StreamElements, which has no list. |
| `/control/selftest` | `scripts/smoke-packaged.mjs` writes and screens real captions for two songs at once, through the turn-taking queue. |

`GET /health` and `GET /recent` (the song and facts last sent) need no header.

### What every 2.x release keeps working

From 2.0.0, the first stable release, these are the app's public
interface: a change that breaks one waits for 3.0 (SemVer).

- **Settings** (`settings.json`): a version reads any older 2.x file. A
  setting it doesn't know is kept when it saves, so going back a version and
  forward again loses nothing. `settingsVersion` records the format. A file
  that reads but isn't a settings object is renamed to `.unreadable`. One that
  can't be read at all (a lock from an antivirus program or OneDrive) is tried
  a few times, then the defaults stand in for this run and nothing is saved
  over it, so the sign-in survives.
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
  credited only when the streamer names one. An entry can also hold the two
  switches, with or without facts.
- `song-facts.before-switches.json`: the song facts as they were before the
  first switch was saved, copied once, for going back to an older version
  (which shows nothing for a song that has only a switch).
- `wrong-facts.json`: sources marked **Wrong** (above).
- `session.json`: the song that was showing, its facts, when they went out,
  and recent facts (see "What gets remembered between songs?").
- `wrong-log.jsonl`: one line per **Wrong** press, the newest 500 (see the
  file table above).

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
  site and README ask streamers to credit the sources. A fact about the good
  an artist does is one sentence as the article wrote it: the credit bubble names
  Wikipedia, and the dashboard links the article.
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
