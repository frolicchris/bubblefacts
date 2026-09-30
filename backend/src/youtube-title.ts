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
 * song gets backup facts; it never attributes a song to the wrong work.
 */

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
 * A " - " or " | " segment that only describes the upload. A lone word is
 * dropped only when it's always a label, and only among three or more
 * segments otherwise, so "Taylor Swift - 22" and "Artist - Video" survive.
 */
function labelSegment(segment: string, count: number): boolean {
  if (!/\p{L}/u.test(segment) || !onlyNoise(segment, SEGMENT_NOISE_RE)) return false;
  return count > 2 || /\s/.test(segment) || LABEL_WORD.test(segment);
}

/** "ft. X", "feat. X", "featuring X": not part of the song's name. */
const FEATURING = /\s*(?:^|\s)(?:ft\.?|feat\.?|featuring)\s.*$/i;
const FEATURING_BRACKET = /^\s*(?:ft\.?|feat\.?|featuring|with)\s/i;
/** "(From "Frozen")": the bracket names the work the song comes from. */
const FROM_BRACKET = /^\s*from\s+["'“”‘’]?(.+?)["'“”‘’]?\s*$/i;
/** "(Ocarina of Time OST)": a soundtrack, so the bracket names the work. */
const SOUNDTRACK = /\s*\b(?:original\s+(?:game\s+|motion\s+picture\s+)?soundtrack|o\.?s\.?t\.?|soundtrack)\b\s*/gi;
const HAS_SOUNDTRACK = /\b(?:soundtrack|o\.?s\.?t\.?)(?=$|[^\p{L}])/iu;

const BRACKETS = /\s*(?:\(([^()]*)\)|\[([^[\]]*)\]|【([^【】]*)】|「([^「」]*)」)\s*/g;
const DASH = /\s+[-–—~]\s+/;

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

/** Folded for comparison: case, accents and punctuation don't count. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The artist an uploader's name gives, when it's an official channel:
 * "CiaraVEVO" is Ciara, "Ciara - Topic" is YouTube's auto-generated channel
 * for Ciara. Anything else is only a guess (it may be a cover channel).
 */
export function artistFromChannel(channel: string | undefined | null): { artist: string; official: boolean } {
  const name = (channel ?? "").trim();
  if (!name) return { artist: "", official: false };
  const topic = name.match(/^(.+?)\s+-\s+topic$/i);
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
  // Hashtags describe the upload ("#saxdragon #Keytar"), never the song.
  const raw = (rawTitle ?? "").replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ").replace(/\s+/g, " ").trim();
  let source = "";

  // 1. Brackets: drop the upload's own labels, keep what names the song or its source.
  let text = raw.replace(BRACKETS, (whole, a, b, c, d) => {
    const inner: string = (a ?? b ?? c ?? d ?? "").trim();
    if (!inner || onlyNoise(inner, NOISE_RE) || FEATURING_BRACKET.test(inner)) return " ";
    const from = inner.match(FROM_BRACKET);
    if (from) {
      source ||= withoutSoundtrack(from[1]);
      return " ";
    }
    if (HAS_SOUNDTRACK.test(inner)) {
      // "(Soundtrack by Ramin Djawadi)" credits a composer; it doesn't name the work.
      const work = withoutSoundtrack(inner);
      if (!/^by\s/i.test(work)) source ||= work;
      return " ";
    }
    return whole;
  });

  // 2. " | " segments: the first is the song; a later one may name its source.
  const pipeSplit = text.split(/\s*[|｜]\s*/).map(tidy).filter(Boolean);
  const pipes = pipeSplit.filter((p, i) => i === 0 || !labelSegment(p, pipeSplit.length));
  text = pipes[0] ?? "";

  // 3. " - " segments, minus any that only describe the upload ("- Official Video").
  const dashSplit = text.split(DASH).map(tidy).filter(Boolean);
  const parts = dashSplit.filter((p) => !labelSegment(p, dashSplit.length));
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
    // 'Artist "Song"', a common uploader style without a dash.
    const quoted = title.match(/^(.+?)\s+["“](.+)["”]$/);
    if (quoted) {
      artist = tidy(stripFeaturing(quoted[1]));
      title = quoted[2];
      confident = true;
    }
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

/**
 * Uploaders put "Artist - Song" nearly always, but game and film music often
 * comes as "Track - Work". Swap only on a clear sign:
 *  - the channel is the right side's artist and not the left's;
 *  - the right side is a soundtrack ("... OST");
 *  - the right side has a subtitle ("The Legend of Zelda: Ocarina of Time")
 *    and the left doesn't, which is how works are titled, not songs.
 */
/** "Saturday Night Live" -> "snl". */
function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words.length >= 2 ? words.map((w) => w[0]).join("").toLowerCase() : "";
}

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
