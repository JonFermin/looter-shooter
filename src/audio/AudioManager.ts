// Audio playback layer. Wraps HTMLAudioElement with:
//   - preloading at scene start (no first-play stutter)
//   - per-sound voice pools so rapid-fire shots don't queue and lag
//   - a master volume constant
//   - a "muted until user gesture" gate (autoplay policy compliance)
//
// Why HTMLAudioElement and not Babylon Sound: Babylon's audio engine
// requires sceneAudioEngine setup + WebAudio context wiring. For a vertical
// slice with ~10 distinct one-shots and no spatialization, the browser's
// built-in <audio> element is plenty.
//
// Voice pool: each registered sound maintains N HTMLAudioElement clones.
// play() picks the LRU voice — least-recently-played, can preempt mid-play
// if needed. This is enough for overlapping fire / impact without tearing.
//
// Singleton state survives HMR. All exported functions are top-level so the
// Player / Weapon / Enemy callers don't need a manager handle threaded
// through their constructors.

const MASTER_VOLUME = 0.6;
const FIRE_VOICE_COUNT = 4;
const IMPACT_VOICE_COUNT = 4;
const DEFAULT_VOICE_COUNT = 2;

interface Voice {
  audio: HTMLAudioElement;
  lastPlayedAt: number;
}

interface SoundEntry {
  voices: Voice[];
  baseVolume: number;
}

const sounds = new Map<string, SoundEntry>();
let unlocked = false;

/**
 * Register a sound under `key`. Idempotent — repeated calls with the same
 * key are no-ops, which keeps registerAllSounds() safe across HMR reloads
 * that re-run scene setup against the surviving module singleton.
 *
 * `voiceCount` controls the polyphony: 4 for fire (overlapping shots), 1
 * for the looped footstep, 2 for casual one-shots like reload.
 */
export function registerSound(
  key: string,
  url: string,
  voiceCount = DEFAULT_VOICE_COUNT,
  volume = 1.0,
): void {
  if (sounds.has(key)) return;
  const voices: Voice[] = [];
  for (let i = 0; i < voiceCount; i++) {
    const audio = new Audio(url);
    audio.preload = "auto";
    audio.volume = MASTER_VOLUME * volume;
    voices.push({ audio, lastPlayedAt: 0 });
  }
  sounds.set(key, { voices, baseVolume: volume });
}

/**
 * Mark the AudioManager as user-gesture-authorized so subsequent play()
 * calls can actually start audio. Browsers reject audio.play() before any
 * user gesture has occurred on the page; the Arena scene wires this to a
 * one-shot canvas click + the StartScreen dismiss handler.
 */
export function unlock(): void {
  unlocked = true;
}

/**
 * Play the registered sound by key. Picks the LRU voice (least recently
 * played) and resets its currentTime to 0 so a new shot doesn't tear into
 * a still-playing instance. Silent no-op until unlock() has been called.
 */
export function play(key: string): void {
  if (!unlocked) return;
  const entry = sounds.get(key);
  if (!entry) return;
  const voices = entry.voices;
  if (voices.length === 0) return;
  let target: Voice | undefined = voices[0];
  for (const v of voices) {
    if (target === undefined || v.lastPlayedAt < target.lastPlayedAt) {
      target = v;
    }
  }
  if (!target) return;
  target.lastPlayedAt = performance.now();
  target.audio.currentTime = 0;
  void target.audio.play().catch(() => {
    // Autoplay rejection / network glitch — silent. Sound is non-critical.
  });
}

/** Pick + play a random sound from a list of keys. */
export function playRandom(keys: readonly string[]): void {
  if (keys.length === 0) return;
  const idx = Math.floor(Math.random() * keys.length);
  const k = keys[idx];
  if (k) play(k);
}

/**
 * Loop a sound; returns a stop function the caller invokes when the loop
 * should end. Used for footsteps. Uses the first voice slot since the loop
 * is owned by exactly one source — caller must not call startLoop() twice
 * on the same key without invoking the previous stop function first.
 */
export function startLoop(key: string): () => void {
  if (!unlocked) return () => {};
  const entry = sounds.get(key);
  if (!entry) return () => {};
  const voice = entry.voices[0];
  if (!voice) return () => {};
  voice.audio.loop = true;
  voice.audio.currentTime = 0;
  void voice.audio.play().catch(() => {});
  return () => {
    voice.audio.pause();
    voice.audio.loop = false;
  };
}

/**
 * Register every audio asset the game uses. Called once at scene setup —
 * Arena.ts invokes this during createArenaScene before the first audio
 * event can fire so the browser has time to fetch the .ogg/.wav files.
 */
export function registerAllSounds(): void {
  registerSound("fire-1", "/assets/audio/gun-1.ogg", FIRE_VOICE_COUNT, 0.7);
  registerSound("fire-2", "/assets/audio/gun-2.ogg", FIRE_VOICE_COUNT, 0.7);
  registerSound("fire-3", "/assets/audio/gun-3.ogg", FIRE_VOICE_COUNT, 0.7);
  registerSound("fire-4", "/assets/audio/gun-4.ogg", FIRE_VOICE_COUNT, 0.7);
  registerSound("fire-5", "/assets/audio/gun-5.ogg", FIRE_VOICE_COUNT, 0.7);
  registerSound("reload", "/assets/audio/reload.ogg");
  registerSound("no-ammo", "/assets/audio/no-ammo.ogg");
  registerSound("impact-1", "/assets/audio/impact-1.ogg", IMPACT_VOICE_COUNT, 0.6);
  registerSound("impact-2", "/assets/audio/impact-2.ogg", IMPACT_VOICE_COUNT, 0.6);
  registerSound("scream-1", "/assets/audio/scream-1.ogg");
  registerSound("scream-2", "/assets/audio/scream-2.ogg");
  registerSound("scream-3", "/assets/audio/scream-3.ogg");
  registerSound("scream-4", "/assets/audio/scream-4.ogg");
  registerSound("scream-5", "/assets/audio/scream-5.ogg");
  registerSound("scream-6", "/assets/audio/scream-6.ogg");
  registerSound("footstep", "/assets/audio/sand-step.ogg", 1, 0.4);
  registerSound("ufo-fire", "/assets/audio/laser.wav", 2, 0.5);
  registerSound("ufo-death", "/assets/audio/space-boss-death.wav", 1, 0.7);
  registerSound("player-death", "/assets/audio/topdown-death.wav", 1, 0.8);
}

/** Convenience key tuples for callers that want a random fire/scream/impact. */
export const FIRE_KEYS = ["fire-1", "fire-2", "fire-3", "fire-4", "fire-5"] as const;
export const IMPACT_KEYS = ["impact-1", "impact-2"] as const;
export const SCREAM_KEYS = [
  "scream-1",
  "scream-2",
  "scream-3",
  "scream-4",
  "scream-5",
  "scream-6",
] as const;
