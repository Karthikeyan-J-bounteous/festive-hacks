// Sarvam client (SPEC-LITE §14.1): keyless fallback, request shape, caching, failure fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSarvamCache, speak, translate, voiceLine } from './sarvam';

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe('sarvam', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearSarvamCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('without a key: English text back, no audio, no network', async () => {
    vi.stubEnv('SARVAM_API_KEY', '');
    expect(await translate('Hello', 'ta-IN')).toBe('Hello');
    expect(await speak('Hello', 'en-IN')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('translates with Mayura, speaks with Bulbul, and caches by (lang, text)', async () => {
    vi.stubEnv('SARVAM_API_KEY', 'k');
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/translate') ? ok({ translated_text: 'வணக்கம்' }) : ok({ audios: ['UklGRg=='] }));

    expect(await voiceLine('Hello', 'ta-IN')).toEqual({ text: 'வணக்கம்', audio: 'UklGRg==' });
    expect(await voiceLine('Hello', 'ta-IN')).toEqual({ text: 'வணக்கம்', audio: 'UklGRg==' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // second line came from the cache

    const [tUrl, tInit] = fetchMock.mock.calls[0];
    expect(tUrl).toBe('https://api.sarvam.ai/translate');
    expect(tInit.headers['api-subscription-key']).toBe('k');
    expect(JSON.parse(tInit.body)).toMatchObject({
      input: 'Hello', source_language_code: 'en-IN', target_language_code: 'ta-IN', model: 'mayura:v1',
    });
    const [sUrl, sInit] = fetchMock.mock.calls[1];
    expect(sUrl).toBe('https://api.sarvam.ai/text-to-speech');
    expect(JSON.parse(sInit.body)).toMatchObject({ text: 'வணக்கம்', language_code: 'ta-IN', model: 'bulbul:v4-flash', output_audio_codec: 'mp3' });
  });

  it('English needs no translation call', async () => {
    vi.stubEnv('SARVAM_API_KEY', 'k');
    fetchMock.mockImplementation(() => ok({ audios: ['AAA='] }));
    expect(await voiceLine('Hi', 'en-IN')).toEqual({ text: 'Hi', audio: 'AAA=' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('on failure falls back to English and retries next time instead of caching the failure', async () => {
    vi.stubEnv('SARVAM_API_KEY', 'k');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('timeout')));
    expect(await translate('Hello', 'hi-IN')).toBe('Hello');

    fetchMock.mockImplementationOnce(() => ok({ translated_text: 'नमस्ते' }));
    expect(await translate('Hello', 'hi-IN')).toBe('नमस्ते');

    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 500 })));
    expect(await speak('x', 'hi-IN')).toBeNull();
  });
});
