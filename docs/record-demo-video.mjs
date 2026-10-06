// Records site/assets/demo.mp4 from the real overlay (frontend/obs), not a mock-up.
// A stand-in server sends one song and three facts; Playwright's fake clock drives the
// overlay's timers and every CSS animation is seeked to the same clock, so each frame
// is exactly 1/30 s apart. Needs Playwright and ffmpeg, which are not project dependencies:
//   npm install --no-save playwright && node docs/record-demo-video.mjs frontend/obs/obs-overlay.html BACKDROP.jpg /tmp/frames 15
//   ffmpeg -framerate 30 -i /tmp/frames/f%04d.png -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart site/assets/demo.mp4
// BACKDROP.jpg is a 1600x900 stream scene (the current clip uses Chris's piano photo, dimmed and softened).
// The facts are the same source-checked ones the earlier still image showed.
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const [overlayArg, bgArg, out, seconds = '15'] = process.argv.slice(2);
const overlay = resolve(overlayArg), bg = resolve(bgArg);
const FPS = 30, W = 1600, H = 900;
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });

const song = { title: 'Song of Storms', artist: 'The Legend of Zelda: Ocarina of Time' };
const facts = [
	{ text: 'Koji Kondo wrote The Legend of Zelda’s overworld theme within a day, after learning Ravel’s “Boléro” wasn’t yet public domain in Japan.', delaySeconds: 0.6, durationSeconds: 8, position: { top: '9%', left: '33%' } },
	{ text: 'In Ocarina of Time, Link learns the Song of Storms from a man in Kakariko Village’s windmill.', delaySeconds: 3.2, durationSeconds: 7, position: { top: '40%', left: '9%' } },
	{ text: 'Ocarina of Time was released in 1998 for the Nintendo 64.', delaySeconds: 5.6, durationSeconds: 6, position: { top: '63%', left: '42%' } },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(({ song, facts }) => {
	// Stand-in for the BubbleFacts server: one song, then its facts.
	window.WebSocket = class {
		constructor() {
			setTimeout(() => this.onopen?.(), 0);
			setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'new_song', song }) }), 700);
			setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'facts_ready', song, facts }) }), 1000);
		}
		close() {}
	};
}, { song, facts });

// Fake clock for the overlay's timers; CSS animations are paused and seeked to the same clock.
await page.clock.install({ time: 0 });
await page.clock.pauseAt(1000);
await page.goto('file://' + overlay);
await page.addStyleTag({ content: `html{background:#0b0d1a url("file://${bg}") center/cover no-repeat}#connection-status{display:none}` });
await page.evaluate(() => {
	const started = new WeakMap();
	window.__sync = (now) => {
		for (const a of document.getAnimations()) {
			if (!started.has(a)) { started.set(a, now); a.pause(); }
			a.currentTime = now - started.get(a);
		}
	};
});
const total = Math.round(Number(seconds) * FPS);
for (let i = 0; i < total; i++) {
	const now = Math.round(((i + 1) * 1000) / FPS);
	await page.clock.runFor(now - Math.round((i * 1000) / FPS));
	await page.evaluate((t) => window.__sync(t), now);
	await page.screenshot({ path: `${out}/f${String(i).padStart(4, '0')}.png`, animations: 'allow' });
}
await browser.close();
console.log(`${total} frames`);
