/**
 * On-device semantic goal matcher: all-MiniLM-L6-v2 (quantized) through
 * Transformers.js. Model and ONNX runtime are vendored under /models and
 * /ort and remote loading is disabled, so nothing is fetched from a CDN.
 * Loaded lazily the first time live mode starts.
 */
type Extractor = (text: string, options: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array }>;

let extractor: Promise<Extractor> | null = null;
const cache = new Map<string, Float32Array>();

export type SemanticStatus = 'idle' | 'loading' | 'ready' | 'failed';
export let semanticStatus: SemanticStatus = 'idle';

export function loadSemantic(onProgress: (label: string) => void = () => {}): Promise<Extractor> {
  if (extractor) return extractor;
  semanticStatus = 'loading';
  extractor = (async () => {
    const tf = await import('@huggingface/transformers');
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
    tf.env.localModelPath = new URL('models/', document.baseURI).href;
    const wasm = tf.env.backends.onnx.wasm;
    if (wasm) {
      wasm.wasmPaths = new URL('ort/', document.baseURI).href;
      wasm.numThreads = 1;
    }
    const pipe = await tf.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p: { status?: string; progress?: number }) => {
        if (p.status === 'progress' && typeof p.progress === 'number') onProgress(`Loading the on-device goal matcher… ${Math.round(p.progress)}%`);
      },
    });
    semanticStatus = 'ready';
    onProgress('Goal matcher ready (MiniLM, on-device).');
    return pipe as unknown as Extractor;
  })().catch((error) => {
    semanticStatus = 'failed';
    extractor = null;
    throw error;
  });
  return extractor;
}

async function embed(text: string): Promise<Float32Array> {
  const key = text.slice(0, 2000);
  const hit = cache.get(key);
  if (hit) return hit;
  const run = await loadSemantic();
  const out = await run(key, { pooling: 'mean', normalize: true });
  const vec = out.data;
  if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  cache.set(key, vec);
  return vec;
}

/** Cosine similarity of two texts (vectors are already normalized). */
export async function semanticSimilarity(a: string, b: string): Promise<number> {
  const [x, y] = await Promise.all([embed(a), embed(b)]);
  let dot = 0;
  for (let i = 0; i < x.length; i++) dot += x[i] * y[i];
  return dot;
}

/**
 * Maps MiniLM cosine onto the engine's similarity scale. Unrelated text sits
 * near 0–0.15, paraphrases of the goal near 0.5+. Conservative on purpose:
 * it can only *raise* on-task evidence for near-topic pages the term matcher
 * misses (e.g. "stoichiometry" for "limiting reagent"); it never lowers it.
 */
export function scaleSemantic(cosine: number): number {
  return Math.max(0, Math.min(1, (cosine - 0.15) / 0.45));
}
