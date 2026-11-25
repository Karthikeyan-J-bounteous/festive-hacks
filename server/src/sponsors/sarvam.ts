// Sarvam AI (SPEC-LITE §14.1): "your turn" in the guest's language.
// Mayura translates the English line, Bulbul speaks it. Keyless-safe: with no SARVAM_API_KEY
// translate() returns the English text and speak() returns null. Every call has a 3 s timeout,
// never throws, and results are cached in memory by (lang, text), so repeats cost nothing.
// API reference checked 2026-11-25: POST /translate, POST /text-to-speech, header `api-subscription-key`.

export const LANGS = ['en-IN', 'ta-IN', 'hi-IN', 'kn-IN', 'te-IN', 'ml-IN'] as const;
export type Lang = (typeof LANGS)[number];

const BASE = 'https://api.sarvam.ai';
const TIMEOUT_MS = 3_000;
// TTS measured 2–4+ s for one sentence, so it gets longer. It still runs after the commit and
// never blocks a ticket action; socket.ts also pre-warms the line at the "almost" nudge.
const TTS_TIMEOUT_MS = 8_000;
const MAX_CACHE = 500;
const TRANSLATE_MODEL = 'mayura:v1';
// Measured 2026-11-25: bulbul:v3 took 4–5 s (over the 3 s budget); v4-flash + mp3 ~1.8 s and ~30 KB.
// v4-flash voices are per-language persona ids, so we leave `speaker` unset and use the model default.
const TTS_MODEL = 'bulbul:v4-flash';
const TTS_CODEC = 'mp3';

const key = (): string => process.env.SARVAM_API_KEY ?? '';
export const sarvamEnabled = (): boolean => key().length > 0;

const textCache = new Map<string, Promise<string>>();
const audioCache = new Map<string, Promise<string | null>>();

/** Memoise a promise; a failed (fallback) result is dropped so the next call retries. */
function cached<T>(cache: Map<string, Promise<T>>, k: string, make: () => Promise<{ value: T; ok: boolean }>): Promise<T> {
  const hit = cache.get(k);
  if (hit) return hit;
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  const p = make().then(({ value, ok }) => {
    if (!ok) cache.delete(k);
    return value;
  });
  cache.set(k, p);
  return p;
}

async function post<T>(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-subscription-key': key() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`sarvam ${path} ${res.status}`);
  return (await res.json()) as T;
}

/** English → `lang`. Falls back to the English text on any problem. */
export function translate(text: string, lang: Lang): Promise<string> {
  if (lang === 'en-IN' || !sarvamEnabled()) return Promise.resolve(text);
  return cached(textCache, `${lang}|${text}`, async () => {
    try {
      const r = await post<{ translated_text?: string }>('/translate', {
        input: text, source_language_code: 'en-IN', target_language_code: lang, model: TRANSLATE_MODEL,
      });
      return r.translated_text ? { value: r.translated_text, ok: true } : { value: text, ok: false };
    } catch (e) {
      console.warn('[sarvam] translate failed:', (e as Error).message);
      return { value: text, ok: false };
    }
  });
}

/** Text in `lang` → base64 MP3, or null on any problem. */
export function speak(text: string, lang: Lang): Promise<string | null> {
  if (!sarvamEnabled()) return Promise.resolve(null);
  return cached(audioCache, `${lang}|${text}`, async () => {
    try {
      const r = await post<{ audios?: string[] }>('/text-to-speech', {
        text, language_code: lang, model: TTS_MODEL, output_audio_codec: TTS_CODEC,
      }, TTS_TIMEOUT_MS);
      const audio = r.audios?.[0] ?? null;
      return { value: audio, ok: !!audio };
    } catch (e) {
      console.warn('[sarvam] text-to-speech failed:', (e as Error).message);
      return { value: null, ok: false };
    }
  });
}

/** Translated line plus its audio (audio may be null). */
export async function voiceLine(english: string, lang: Lang): Promise<{ text: string; audio: string | null }> {
  const text = await translate(english, lang);
  // If translation fell back to English, speak English so voice and text match.
  return { text, audio: await speak(text, text === english ? 'en-IN' : lang) };
}

export const asLang = (v: string | null | undefined): Lang => (LANGS as readonly string[]).includes(v ?? '') ? (v as Lang) : 'en-IN';

/** Test hook. */
export function clearSarvamCache(): void {
  textCache.clear();
  audioCache.clear();
}
