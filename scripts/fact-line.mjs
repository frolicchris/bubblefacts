// One fact as a line of JSON, shaped like the app's wrong-log.jsonl (backend/src/wrong-log.ts), for
// scripts/check-song-list.mjs: a fact judged wrong becomes a case the same way a Wrong press does

/** `article` is what Wrong would block for the fact's source, or null */
export function factLine(song, fact, article) {
  return {
    song: { title: song.title, artist: song.artist ?? "" },
    caption: fact.text,
    source: fact.source ?? null,
    article,
    ...(fact.evidence ? { evidence: fact.evidence } : {}),
  };
}
