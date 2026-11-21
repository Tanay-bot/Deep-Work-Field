/**
 * Transformers.js keeps one global `env`. The semantic matcher must load only
 * vendored local files; the optional Kokoro voice is a one-time, user-started
 * download. Loads are serialized so neither sees the other's settings.
 */
let chain: Promise<unknown> = Promise.resolve();

export function withModelEnv<T>(configure: (env: any) => void, load: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const tf = await import('@huggingface/transformers');
    configure(tf.env);
    const wasm = tf.env.backends.onnx.wasm;
    if (wasm) {
      // Same vendored ONNX runtime for every model; no CDN.
      wasm.wasmPaths = new URL('ort/', document.baseURI).href;
      wasm.numThreads = 1;
    }
    return load();
  });
  chain = run.catch(() => undefined);
  return run;
}
