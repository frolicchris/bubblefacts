import { WRONG_KEYS, WrongKey } from "./settings";

export const PRESS_GAP_MS = 1500; // ms: presses closer than this count once (key repeat, pedal bounce)

/** The part of Electron's globalShortcut this needs, so tests run without Electron */
export interface Shortcuts {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Hands-free Wrong: one global key for a foot pedal or Stream Deck, as hands are busy mid-song; held only while on */
export class WrongKeyListener {
  private held: string | null = null;
  /** Why the chosen key couldn't be used, for Settings; "" when fine or off */
  problem = "";

  private lastPress = 0;

  constructor(private shortcuts: Shortcuts, private onPress: () => void, private now: () => number = Date.now) {}

  private press = (): void => {
    const t = this.now();
    if (t - this.lastPress < PRESS_GAP_MS) return;
    this.lastPress = t;
    this.onPress();
  };

  /** Listen for `key`, letting go of any other; the problem, or "" */
  use(key: WrongKey): string {
    const accelerator = WRONG_KEYS[key] ?? null;
    if (accelerator === this.held && !this.problem) return "";
    this.stop();
    if (!accelerator) return "";
    let ok = false;
    try {
      ok = this.shortcuts.register(accelerator, this.press);
    } catch {
      ok = false;
    }
    if (ok) this.held = accelerator;
    // Registering fails when another app has the key
    else this.problem = "Another app is already using that key, so BubbleFacts can't listen for it. Choose another one, or close the other app and save again.";
    return this.problem;
  }

  stop(): void {
    if (this.held) this.shortcuts.unregister(this.held);
    this.held = null;
    this.problem = "";
  }
}
