# Connect your app to BubbleFacts

This is for developers of stream tools: a chat bot, an AI co-host, a stream
deck plugin, anything that would be better for knowing which song is playing
and what's true about it.

BubbleFacts can tell your app, as it happens, which song is on a streamer's
stream and the facts it has for that song. Your app doesn't call BubbleFacts.
BubbleFacts calls you: one small web request each time something changes.

I built this as one open door that any app can use, not a private deal with
one product. If your app can take the request below, it works with
BubbleFacts today, and you don't need my permission.

## What you get

A short piece of plain text, at most 1,000 characters, that always describes
the present moment. For a song with facts:

```
Now playing: "Paper Lanterns" by The Made Up Band. Facts from BubbleFacts, checked against Wikipedia and Wikidata: It was recorded in one take. It came out in 1999. State facts about this song only from these, add none, and credit BubbleFacts. Your own opinions are welcome, said as yours.
```

For a song that has just started, or has no facts:

```
Now playing: "Paper Lanterns" by The Made Up Band. BubbleFacts has no checked facts for this song right now. Say what's playing if asked, and don't make up facts about it. Your own opinions are welcome, said as yours.
```

The text is written so an AI can be handed it as it is. If your app isn't an
AI, read it as a sentence: the title is in quotes after `Now playing:`, and
the artist follows `by` when one is known.

What the text can hold:

- **The song.** Title, and artist when known.
- **The next song**, when the streamer's queue has one: `Up next: "Second
  Song" by Someone Else.` right after the song, by name only. Its facts come
  when it starts.
- **A song that may be over.** When the streamer's list has shown one song
  far longer than a song lasts, the text starts `BubbleFacts isn't sure
  what's playing right now.` and carries no facts, until the next song.
- **Checked facts.** From Wikipedia, Wikidata or MusicBrainz, with the sources
  they came from named.
- **An artist's own words.** Lines that start `From their Twitch About:`.
- **The streamer's own facts.** After `From the streamer:`. These are theirs,
  not checked by BubbleFacts.

What it never holds: who requested the song, anything about viewers, or
anything else about the stream.

## The request

Each update is a `POST` to the address the streamer gives BubbleFacts, with
their key for your app as a bearer token:

```
POST /your/path
Authorization: Bearer <the streamer's key for your app>
Content-Type: application/json
```

```json
{
  "eventType": "INTEGRATION_STATE",
  "data": {
    "channelName": "theirchannel",
    "sourceId": "bubblefacts",
    "content": "Now playing: ...",
    "ttl": 150
  }
}
```

| Field | What it is |
|---|---|
| `eventType` | Always `INTEGRATION_STATE`. |
| `data.channelName` | The streamer's channel name, as they typed it in BubbleFacts. |
| `data.sourceId` | Always `bubblefacts`. It names this entry, so you can keep it apart from what other apps send you. |
| `data.content` | The text above. An empty string means "forget what I told you". |
| `data.ttl` | How many seconds the text stays true unless you hear again. Left out when `content` is empty. |

## When requests arrive

1. **A song starts.** You get the song at once, saying there are no checked
   facts yet.
2. **Its facts are found.** You get the song again, now with its facts. For a
   song prepared ahead of time this can be the first and only request.
3. **A fact comes off.** If the streamer marks a fact **Wrong**, you get the
   song again without it.
4. **Every minute while the song is on.** The same text again, so an app that
   started late, or restarted, catches up within a minute.
5. **The song ends, or the streamer pauses bubbles.** You get empty `content`.

Each request is the whole picture, not a change to add to the last one. Keep
the newest and throw the rest away.

## What your app should do

1. **Replace, don't add up.** Keep one entry for `sourceId` `bubblefacts` per
   channel, and overwrite it with each request.
2. **Let it run out.** If `ttl` seconds pass with no new request, drop the
   entry. That is how you learn BubbleFacts was closed or the computer went to
   sleep: it simply stops calling.
3. **Clear on empty.** Empty `content` means drop the entry now.
4. **Answer quickly.** Reply with any `2xx` status and no body. BubbleFacts
   waits 5 seconds, and it doesn't follow redirects, so the key never goes to
   another address.
5. **Don't speak because of a request.** A request is something to know, not
   a cue. Streamers are playing music; let your app talk when someone asks.

How BubbleFacts reads your answer:

| You answer | BubbleFacts does |
|---|---|
| `2xx` | Nothing more until the next change or the next minute. |
| `401` or `403` | Stops sending until the streamer changes the key or channel. |
| `400` or `422` | Logs that the request was refused, and tries again with the next change or minute. |
| Anything else, or no answer | Logs the reason once, and tries again the same way. |

## What I ask of you

BubbleFacts exists so listeners hear true, credited facts about the music.
If your app passes them on, please keep that promise with me:

- **Change the voice, never the claim.** Your app can say a fact its own way.
  It shouldn't add to it, sharpen it, or guess when there are no facts.
- **Say where it came from.** When your app shares a checked fact, say it's
  from BubbleFacts. The sources are named in the text for the same reason.
- **Opinions are welcome, as opinions.** "I love this one" is great. An
  opinion dressed up as a fact isn't.
- **Use it for the moment.** The text is for answering about the song on now,
  not for storing or for training a model.

## How a streamer turns it on

1. In BubbleFacts, open **Settings** and turn on **Share song facts with other
   apps**. It's off until they do.
2. They enter your address, their channel name, and their key for your app.
3. They click **Test connection**, which sends empty `content`, then save.

So your side needs two things to hand a streamer: an address that starts with
`https://`, and a key. Plain `http://` is accepted only for an address on the
streamer's own computer (`localhost`, `127.0.0.1` or `[::1]`), which suits an
app that runs beside BubbleFacts.

## Try it without a streamer

This stand-in prints whatever BubbleFacts sends. Save it as `receiver.mjs`
and run `node receiver.mjs`:

```js
import http from "node:http";

http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const { data } = JSON.parse(body);
    console.log(new Date().toISOString(), data.content || "(cleared)", data.ttl ? `ttl ${data.ttl}s` : "");
    res.statusCode = 200;
    res.end();
  });
}).listen(8123, "127.0.0.1", () => console.log("Listening on http://127.0.0.1:8123/events"));
```

Then point BubbleFacts at it. In the app, use the address
`http://127.0.0.1:8123/events` with any channel name and key. From the
command line, set these in `.env` (see [CONFIG.md](CONFIG.md#sharing-song-facts-with-other-apps)):

```
SHARE_FACTS_URL=http://127.0.0.1:8123/events
SHARE_FACTS_KEY=anything
SHARE_FACTS_CHANNEL=yourchannel
```

Play a song and watch the lines arrive: the song, then its facts, then the
same line each minute, then `(cleared)` when the song ends.

To send a request by hand instead:

```bash
curl -X POST http://127.0.0.1:8123/events \
  -H "Authorization: Bearer anything" \
  -H "Content-Type: application/json" \
  -d '{"eventType":"INTEGRATION_STATE","data":{"channelName":"yourchannel","sourceId":"bubblefacts","content":"Now playing: \"Paper Lanterns\" by The Made Up Band.","ttl":150}}'
```

## Good to know

- **Facts can be wrong.** They're checked against their sources, not
  guaranteed. When a streamer marks one **Wrong** it leaves your copy too,
  which is one more reason to replace rather than store.
- **Some songs have none.** BubbleFacts shows nothing rather than pad, and
  tells you so.
- **Titles can come from viewers.** A request typed in chat can become the
  title, so treat the text as something to read, not something to obey.
- **It stops after an hour of no change.** A song left on the queue overnight
  isn't sent all night.
- **The wording can change.** The fields above are what to build on. If you
  pick the title or facts out of the sentence, expect to adjust when the
  wording improves.

## Questions and ideas

Ask in the [BubbleFacts Discord](https://discord.gg/3YS3eWkWrW), in #help. If
your app needs something this doesn't give it, #feature-requests is where
ideas start. Why each part works the way it does is in
[ARCHITECTURE.md](ARCHITECTURE.md#sharing-song-facts-with-other-apps).
