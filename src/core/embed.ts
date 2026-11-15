import { join } from 'node:path';
import { DATA_DIR } from './db.ts';
import { splitAlternatives } from './qtypes.ts';

/**
 * Local sentence embeddings (all-MiniLM-L6-v2, 8-bit, ~23 MB) for meaning-based duplicate checks.
 * Downloaded once into data/models on first use, then fully offline. Every caller must handle
 * `null` (model unavailable): duplicate checks then fall back to wording similarity only.
 */
export const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DIM = 384;

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let loading: Promise<Extractor | null> | null = null;
let failed = false;

export function modelStatus() {
  return failed ? 'unavailable' : loading ? 'loaded' : 'not loaded';
}

function load(): Promise<Extractor | null> {
  if (process.env.SOCRATES_EMBEDDINGS === 'off') return Promise.resolve(null);
  loading ??= (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.SOCRATES_MODELS ?? join(DATA_DIR, 'models');
      // Containers ship the model in the image and have no network: never try to download.
      if (process.env.SOCRATES_MODELS_OFFLINE === '1') env.allowRemoteModels = false;
      return (await pipeline('feature-extraction', MODEL, { dtype: 'q8' })) as unknown as Extractor;
    } catch (e: any) {
      failed = true;
      console.error(`[socrates] Embedding model unavailable, using wording-only duplicate checks: ${e.message}`);
      return null;
    }
  })();
  return loading;
}

/** Text that represents a question's meaning: the prompt without markup noise. */
export function embedText(prompt: string): string {
  return prompt
    .replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, (_m, a: string) => splitAlternatives(a)[0])
    .replace(/\{\{\s*blank\s*\}\}/g, '___')
    .replace(/```[\w-]*\n?/g, '')
    .replace(/[*_#>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

export async function embed(texts: string[]): Promise<Float32Array[] | null> {
  if (!texts.length) return [];
  const f = await load();
  if (!f) return null;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const res = await f(texts.slice(i, i + 32), { pooling: 'mean', normalize: true });
    for (const v of res.tolist()) out.push(Float32Array.from(v));
  }
  return out;
}

export const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** Vectors are normalized, so cosine is a dot product. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
