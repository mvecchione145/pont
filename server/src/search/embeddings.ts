import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { config } from '../config.js';

// Local embedding model (no API key, works offline once downloaded). The
// default, bge-small-en-v1.5, produces 384-dimension vectors and expects
// search queries to carry a short instruction prefix; documents don't.

interface ModelProfile {
  pooling: 'cls' | 'mean';
  queryPrefix: string;
  // The model's context window, in tokens. Chunks are sized to fit it.
  maxTokens: number;
}

function profileFor(model: string): ModelProfile {
  if (/bge-/i.test(model)) {
    return {
      pooling: 'cls',
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
      maxTokens: 512,
    };
  }
  return { pooling: 'mean', queryPrefix: '', maxTokens: 256 };
}

export const model = config.search.embeddingModel;
export const profile = profileFor(model);

env.cacheDir = config.search.modelCacheDir;

let loading: Promise<FeatureExtractionPipeline> | null = null;
let ready = false;

// Loads the model once; downloads it into the cache on first use.
export function loadModel(): Promise<FeatureExtractionPipeline> {
  loading ??= pipeline('feature-extraction', model, { dtype: 'q8' }).then((extractor) => {
    ready = true;
    return extractor as FeatureExtractionPipeline;
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

export const modelReady = () => ready;

async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await loadModel();
  const output = await extractor(texts, { pooling: profile.pooling, normalize: true });
  const [count, dims] = output.dims as [number, number];
  const data = output.data as Float32Array;
  return Array.from({ length: count }, (_, i) => data.slice(i * dims, (i + 1) * dims));
}

export const embedDocuments = (texts: string[]) => embed(texts);

export async function embedQuery(query: string): Promise<Float32Array> {
  const [vector] = await embed([profile.queryPrefix + query]);
  return vector;
}

export async function dimensions(): Promise<number> {
  const [vector] = await embed(['dimension probe']);
  return vector.length;
}

// A token counter using the model's own tokenizer, for sizing chunks.
export async function tokenCounter(): Promise<(text: string) => number> {
  const extractor = await loadModel();
  return (text) => extractor.tokenizer.encode(text).length;
}
