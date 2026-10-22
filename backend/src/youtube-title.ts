/**
 * Turns a YouTube video title into the title and artist the fact pipeline
 * expects. StreamElements' song requests are YouTube videos, so the only
 * song data is the uploader's title ("Ciara - 1, 2 Step (Official Video)
 * ft. Missy Elliott") and the uploader's channel ("CiaraVEVO").
 *
 * The "artist" is whatever the song comes from, as on a StreamerSongList
 * list: a performer, a composer, or a game or film for soundtrack music.
 * `resolveGameAndTrack` in fact-verifier.ts reads it the same way.
 *
 * Everything here is deterministic string work. When a title can't be read
 * with confidence, the cleaned title is kept whole and the artist comes from
 * the channel, which at worst means no Wikipedia article is found and the
 * song gets custom facts; it never attributes a song to the wrong work.
 *
 * Several bracket, label and separator rules follow Web Scrobbler's
 * metadata-filter (MIT, https://github.com/web-scrobbler/metadata-filter).
 * fixtures/youtube-titles.json holds real titles; add every failure seen live.
 */

import { songIdentity } from "./text";

export interface ParsedTitle {
  title: string;
  /** Empty when neither the title nor the channel names one. */
  artist: string;
  /** False when the artist is only a guess from an uploader that may be a cover channel. */
  confident: boolean;
  /**
   * The artist is a performer, not a game or film: the upload calls itself a
   * music video or official audio, or comes from a VEVO or "- Topic" channel.
   */
  performer: boolean;
}

/** An upload that is a performer's own release, not soundtrack music. */
const PERFORMER_UPLOAD = /\b(?:official\s+(?:music\s+)?(?:video|audio|visuali[sz]er|lyric\s+video|mv)|music\s+video|lyric\s+video)\b/i;

/** Words that describe the upload, not the song. A bracket or segment made only of these is dropped. */
const NOISE_WORDS = [
  "official", "music", "video", "videoclip", "clip", "lyrics?", "lyric", "letra", "audio", "visuali[sz]er",
  "hd", "hq", "uhd", "4k", "8k", "1080p", "720p", "60fps", "remaster(?:ed)?", "\\d{4}", "mv", "m/v",
  "explicit", "clean", "full", "song", "version", "ver\\.?", "cover", "piano", "guitar", "violin",
  "acoustic", "instrumental", "karaoke", "tutorial", "synthesia", "sheet", "sheets", "slowed", "reverb",
  "sped", "up", "nightcore", "drums?", "drummer", "bass", "sax", "saxophone", "keytar", "keys", "synth",
  "ukulele", "cello", "flute", "trumpet", "trombone", "clarinet", "harp", "orchestral", "band", "vocals?", "8d", "extended", "\\d+", "hours?", "loop", "animated", "with", "and", "on",
  "the", "a", "in", "high", "quality", "solo", "arr\\.?", "arranged", "arrangement", "performance",
  "premiere", "new", "vevo", "original",
  // Spanish, Portuguese, French and German labels
  "movie", "oficial", "officiel", "officielle", "offizielles", "letra", "vivo", "en", "ao", "legendado", "sub", "español",
];
/** Also dropped when they make up a whole " - " or " | " segment: "Song - Live", "Song | Remix". */
const VARIANT_WORDS = ["live", "remix", "edit", "radio", "mix", "demo", "session", "sessions"];

const wordsRe = (words: string[]) => new RegExp(`(^|[^\\p{L}\\p{N}])(?:${words.join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu");
const NOISE_RE = wordsRe(NOISE_WORDS);
const SEGMENT_NOISE_RE = wordsRe([...NOISE_WORDS, ...VARIANT_WORDS]);

/** Nothing left once the noise words and punctuation are taken out. */
function onlyNoise(text: string, re: RegExp): boolean {
  return !text.replace(re, "$1").replace(/[^\p{L}\p{N}]+/gu, "");
}

/** One word that is always a label on its own, never a song: "Song - Lyrics". */
const LABEL_WORD = /^(?:lyrics?|audio|official|hd|hq|4k|8k|remastered|instrumental|karaoke|nightcore|piano|cover|acoustic|live|remix)$/i;

/**
 * A trailing segment that names where the song was performed, not the song:
 * a late-night or morning show, a concert series, or "Live on/at/from ...".
 * Whole-segment matches only, so "Tonight" or "Live Forever" are still songs.
 * Add a show here when one shows up in a live title.
 */
const PERFORMANCE_SHOWS = [
  "(?:the\\s+)?tonight\\s+show(?:\\s+starring\\s+jimmy\\s+fallon|\\s+with\\s+jay\\s+leno)?",
  "(?:the\\s+)?late\\s+(?:late\\s+)?show(?:\\s+with\\s+[\\p{L}.' ]+)?",
  "late\\s+night(?:\\s+with\\s+[\\p{L}.' ]+)?",
  "(?:the\\s+)?jimmy\\s+kimmel\\s+live!?",
  "(?:the\\s+)?ellen\\s+(?:degeneres\\s+)?show",
  "(?:the\\s+)?today\\s+show",
  "good\\s+morning\\s+america",
  "saturday\\s+night\\s+live",
  "snl",
  "(?:npr\\s+(?:music\\s+)?)?tiny\\s+desk(?:\\s+\\(home\\))?(?:\\s+concerts?)?",
  "(?:a\\s+)?colors\\s+show",
];
const PERFORMANCE_SEGMENT = new RegExp(
  `^(?:${PERFORMANCE_SHOWS.join("|")}|live\\s+(?:on|at|from)\\s+\\S.*)$`,
  "iu",
);

/**
 * A " - " or " | " segment that only describes the upload. A lone word is
 * dropped only when it's always a label, and only among three or more
 * segments otherwise, so "Taylor Swift - 22" and "Artist - Video" survive.
 * A performance or show segment is dropped after the first segment only.
 */
function labelSegment(segment: string, count: number, index = 0): boolean {
  if (index > 0 && PERFORMANCE_SEGMENT.test(segment)) return true;
  if (!/\p{L}/u.test(segment) || !onlyNoise(segment, SEGMENT_NOISE_RE)) return false;
  return count > 2 || /\s/.test(segment) || LABEL_WORD.test(segment);
}

/** "ft. X", "feat. X", "featuring X": not part of the song's name. */
const FEATURING = /\s*(?:^|\s)(?:ft\.?|feat\.?|featuring)\s.*$/i;
const FEATURING_BRACKET = /^\s*(?:ft\.?|feat\.?|featuring|with)\s/i;
/** "(From "Frozen")": the bracket names the work the song comes from. */
// Quotes or a soundtrack word are required: "(From The Vault)" is a label, not a work.
const FROM_BRACKET = /^\s*from\s+(?:["“‘'](.+?)["”’']|(.+?\b(?:soundtrack|o\.?s\.?t\.?|movie|film|series|game)\b.*?))\s*$/i;
/** "(Ocarina of Time OST)": a soundtrack, so the bracket names the work. */
const SOUNDTRACK = /\s*\b(?:original\s+(?:game\s+|motion\s+picture\s+)?soundtrack|o\.?s\.?t\.?|soundtrack)\b\s*/gi;
const HAS_SOUNDTRACK = /\b(?:soundtrack|o\.?s\.?t\.?)(?=$|[^\p{L}])/iu;

const BRACKETS = /\s*(?:\(([^()]*)\)|\[([^[\]]*)\]|【([^【】]*)】|「([^「」]*)」|『([^『』]*)』|｢([^｢｣]*)｣|（([^（）]*)）)\s*/g;
/** " - ", " – ", " ~ ", and a spaced " / " or " // " (never "AC/DC"). */
const DASH = /\s+(?:[-–—~]|\/\/?)\s+/;
/** "(by Artist)", "(performed by Artist)". A cover credit ("cover by X") isn't one: X isn't the song's artist. */
const BY_BRACKET = /^(?:(?:song|music|performed|written|composed|sung)\s+)?by\s+(.+)$/i;
/** "(Spider-Man: Across the Spider-Verse)": a titled work with a subtitle names the song's source. */
const WORK_BRACKET = /^\S.*\S:\s+\S.*\s\S/;
/** A bracket that names a variant of the song. */
const VARIANT_BRACKET = /^(?:live|acoustic|remix|remastered|demo|edit|session|unplugged|stripped)\b/i;
/** Japanese quote marks around the title, with the upload's labels after: LiSA『紅蓮華』MUSiC CLiP. */
const JAPANESE_QUOTED = /^(.+?)\s*[「『｢](.+?)[」』｣]/;
/** Quote marks around a song title, including Japanese ones. */
const QUOTED = /^(.+?)\s*["“「『](.+)["”」』]$/;
/** "Brass Fox's "Billie Jean" Solo": a possessive names the performer, the quotes the song. */
const POSSESSIVE_QUOTED = /^(.+?)['’]s\s+["“「『](.+?)["”」』]/;
/**
 * "Shania Twain_Dirty Rosie": one underscore between letters or digits, words on both sides.
 * Sides are matched by `underscoreSplit`, which also rules out filenames and slugs.
 */
const UNDERSCORE_PAIR = /^([^_]*[\p{L}\p{N}])_([\p{L}\p{N}][^_]*)$/u;
/** Words that make "name_name" a filename or a take label, not an artist and a song. */
const FILENAME_WORD = /^(?:track|audio|video|final|mix|master(?:ed)?|take|demo|draft|untitled|recording|song|music|clip|img|dsc|mov|vid|v\d+|vol\d*|part\d*|copy|new|old|test|temp)$/i;
/** A requester or credit note, whose underscore belongs to a username. */
const REQUESTER_NOTE = /^(?:requested|request|added|queued|sr|song\s+request|from|by)\b/i;
const FILE_EXTENSION = /\.(?:mp3|mp4|m4a|wav|flac|ogg|mov|avi|mkv|webm|aac|wma)$/i;

/**
 * Splits "Artist_Song" when it clearly is two parts: a single underscore, no
 * file extension, neither side a bare short number or a filename word, neither
 * side starting in lowercase (usernames, slugs), and no requester note. Otherwise null.
 */
function underscoreSplit(title: string): { artist: string; title: string } | null {
  const m = title.match(UNDERSCORE_PAIR);
  if (!m || FILE_EXTENSION.test(title)) return null;
  const [left, right] = [m[1].trim(), m[2].trim()];
  if (!left || !right) return null;
  for (const side of [left, right]) {
    if (/^\d{1,3}$/.test(side) || FILENAME_WORD.test(side)) return null;
  }
  // Lowercase starts are usernames and slugs ("Requested by dana_k", "paper_lanterns").
  if (/^\p{Ll}/u.test(left) || /^\p{Ll}/u.test(right) || REQUESTER_NOTE.test(left)) return null;
  return { artist: left, title: right };
}

/** "Marc Rebillet x Edeka": a collaboration, led by the first name. */
const COLLAB = /^(.+?)\s+x\s+\S/;

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—~|:,/]+|[\s\-–—~|:,/]+$/g, "")
    .replace(/^["'“”‘’](.*)["'“”‘’]$/, "$1")
    .trim();
}

function withoutSoundtrack(s: string): string {
  return tidy(s.replace(SOUNDTRACK, " "));
}

/** Folded for comparison: case, accents and punctuation don't count. `songIdentity` without the spaces, so "A-B" and "A B" match too. */
function fold(s: string): string {
  return songIdentity(s).replace(/ /g, "");
}

/** YouTube names auto-generated channels in the viewer's language: "Ciara - Topic", "Ciara - Tema". */
const TOPIC_CHANNEL = /^(.+?)\s+[-–]\s+(?:topic|tema|thema|thème|tópico|argomento|temat|onderwerp|konu|aihe|emne|тема|トピック|主题|主題|주제)$/i;

/** An auto-generated "- Topic" channel, whose uploads carry exact song metadata. */
export function isTopicChannel(channel: string | undefined | null): boolean {
  return TOPIC_CHANNEL.test((channel ?? "").trim());
}

/**
 * The artist an uploader's name gives, when it's an official channel:
 * "CiaraVEVO" is Ciara, "Ciara - Topic" is YouTube's auto-generated channel
 * for Ciara. Anything else is only a guess (it may be a cover channel).
 */
export function artistFromChannel(channel: string | undefined | null): { artist: string; official: boolean } {
  const name = (channel ?? "").trim();
  if (!name) return { artist: "", official: false };
  const topic = name.match(TOPIC_CHANNEL);
  if (topic) return { artist: topic[1].trim(), official: true };
  const vevo = name.match(/^(.+?)\s*vevo$/i);
  if (vevo) {
    // VEVO names run the words together: "TaylorSwiftVEVO".
    const spaced = /\s/.test(vevo[1]) ? vevo[1] : vevo[1].replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
    return { artist: spaced.trim(), official: true };
  }
  return { artist: name, official: false };
}

export function parseVideoTitle(rawTitle: string, channel?: string | null): ParsedTitle {
  // Hashtags describe the upload ("#brassfox #Keytar"), never the song.
  const raw = (rawTitle ?? "").replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ").replace(/\s+/g, " ").trim();
  let source = "";

  // 1. Brackets: drop the upload's own labels, keep what names the song or its source.
  let byArtist = "";
  let work = "";
  let text = raw.replace(BRACKETS, (whole, a, b, c, d, e, f, g) => {
    const inner: string = (a ?? b ?? c ?? d ?? e ?? f ?? g ?? "").trim();
    if (!inner || onlyNoise(inner, NOISE_RE) || FEATURING_BRACKET.test(inner)) return " ";
    const from = inner.match(FROM_BRACKET);
    if (from) {
      source ||= withoutSoundtrack(from[1] ?? from[2] ?? "");
      return " ";
    }
    const by = inner.match(BY_BRACKET);
    if (by) {
      byArtist ||= by[1];
      return " ";
    }
    if (HAS_SOUNDTRACK.test(inner)) {
      // "(Soundtrack by Ramin Djawadi)" credits a composer; it doesn't name the work.
      const soundtrackWork = withoutSoundtrack(inner);
      if (!/^by\s/i.test(soundtrackWork)) source ||= soundtrackWork;
      return " ";
    }
    // "(Live at Glastonbury 2016)", "(Acoustic Version)": a variant of the song, not its name.
    if (VARIANT_BRACKET.test(inner)) return " ";
    // Japanese quote brackets usually hold the song title: keep them for the quote check.
    if (!/^[「『｢]/.test(whole.trim()) && WORK_BRACKET.test(inner)) {
      work ||= inner;
      return " ";
    }
    return whole;
  });

  // 2. " | " segments: the first is the song; a later one may name its source.
  const pipeSplit = text.split(/\s*[|｜]\s*/).map(tidy).filter(Boolean);
  const pipes = pipeSplit.filter((p, i) => i === 0 || !labelSegment(p, pipeSplit.length, i));
  text = pipes[0] ?? "";

  // 3. " - " segments, minus any that only describe the upload ("- Official Video").
  const dashSplit = text.split(DASH).map(tidy).filter(Boolean);
  const parts = dashSplit.filter((p, i) => !labelSegment(p, dashSplit.length, i));
  // "Song - Drum Cover | Artist": once the label is gone, the pipe names the artist.
  const pipeSource = pipes.length > 1 && parts.length < 2 ? pipes[1] : "";
  const channelInfo = artistFromChannel(channel);

  let artist = "";
  let title = "";
  let confident = false;
  let fromSource = false;

  if (parts.length >= 2) {
    let left = parts[0];
    let right = parts.slice(1).join(" - ");
    if (shouldSwap(left, right, channelInfo.artist)) [left, right] = [right, left];
    artist = withoutSoundtrack(stripFeaturing(left));
    if (fold(artist) === initials(channelInfo.artist)) artist = channelInfo.artist;
    title = stripFeaturing(right);
    confident = true;
  } else {
    title = stripFeaturing(parts[0] ?? "");
    // 'Artist "Song"' and 'Artist「Song」', common uploader styles without a dash.
    const quoted = title.match(QUOTED) ?? title.match(POSSESSIVE_QUOTED) ?? title.match(JAPANESE_QUOTED);
    const collab = !quoted && !channelInfo.official ? title.match(COLLAB) : null;
    if (quoted) {
      artist = tidy(stripFeaturing(quoted[1]));
      title = quoted[2];
      confident = true;
    } else if (byArtist) {
      artist = byArtist;
      confident = true;
    } else if (collab) {
      artist = tidy(collab[1]);
    }
    // 'Artist_Song', when nothing else named the artist.
    const underscore = !artist ? underscoreSplit(title) : null;
    if (underscore) {
      artist = underscore.artist;
      title = underscore.title;
      confident = true;
    }
  }

  // A titled work in brackets is the source unless an official channel names the performer.
  if (!artist && work && !channelInfo.official) {
    artist = work;
    confident = true;
    fromSource = true;
  }
  if (!artist && (source || pipeSource)) {
    artist = withoutSoundtrack(source || pipeSource);
    confident = true;
    fromSource = true;
  }
  if (!artist && channelInfo.artist) {
    artist = channelInfo.artist;
    confident = channelInfo.official;
  }

  title = tidy(title);
  // Nothing readable left (a title of only labels): show what the uploader wrote.
  if (!/[\p{L}\p{N}]/u.test(title)) {
    title = raw;
    confident = false;
  }
  const performer = !!artist && !fromSource && (PERFORMER_UPLOAD.test(raw) || channelInfo.official);
  return { title, artist: tidy(artist), confident, performer };
}

function stripFeaturing(s: string): string {
  return tidy(s.replace(FEATURING, ""));
}

/** "Saturday Night Live" -> "snl". */
function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words.length >= 2 ? words.map((w) => w[0]).join("").toLowerCase() : "";
}

/**
 * Uploaders put "Artist - Song" nearly always, but game and film music often
 * comes as "Track - Work". Swap only on a clear sign:
 *  - the channel is the right side's artist and not the left's;
 *  - the right side is the channel's initials ("SNL" from Saturday Night Live);
 *  - the right side is a soundtrack ("... OST");
 *  - the right side has a subtitle ("The Legend of Zelda: Ocarina of Time")
 *    and the left doesn't, which is how works are titled, not songs.
 */
function shouldSwap(left: string, right: string, channelArtist: string): boolean {
  const ch = fold(channelArtist);
  if (ch) {
    if (fold(left) === ch || fold(stripFeaturing(left)) === ch) return false;
    if (fold(right) === ch || fold(stripFeaturing(right)) === ch) return true;
    // "Friendos - SNL" from the Saturday Night Live channel: the show's initials name the source.
    if (fold(right) === initials(channelArtist)) return true;
  }
  if (HAS_SOUNDTRACK.test(right) && !HAS_SOUNDTRACK.test(left)) return true;
  return /\S:\s/.test(right) && !/:/.test(left);
}
