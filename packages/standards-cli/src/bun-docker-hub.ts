import type { ImageDigestResolver } from './bun-pins';
import { isRecord } from './github-settings-parse';

const TOKEN_URL =
  'https://auth.docker.io/token?service=registry.docker.io&scope=repository:oven/bun:pull';
const MANIFEST_URL = 'https://registry-1.docker.io/v2/oven/bun/manifests/';
// The index digest, which a multi-platform image's pin names, comes back for
// an index; the others let a single-platform tag resolve too.
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const TAG = /^[\w][\w.-]{0,127}$/u;
const ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const attempt = async <T>(run: () => Promise<T>): Promise<T> => {
  let failure: unknown;
  for (let index = 0; index < ATTEMPTS; index += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: retries are inherently sequential
      return await run();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
};

// A HEAD request for the manifest, which Docker Hub doesn't count against the
// pull rate limit, with an anonymous pull token.
export const dockerHubDigestResolver = (
  fetcher: Fetch = fetch,
): ImageDigestResolver => {
  const cache = new Map<string, Promise<string>>();
  const resolve = async (tag: string): Promise<string> => {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const auth = await fetcher(TOKEN_URL, { signal });
    const body = auth.ok ? ((await auth.json()) as unknown) : null;
    const token = isRecord(body) ? body.token : undefined;
    if (typeof token !== 'string') {
      throw new Error(
        `Docker Hub refused a pull token for oven/bun (HTTP ${auth.status})`,
      );
    }
    const response = await fetcher(`${MANIFEST_URL}${tag}`, {
      method: 'HEAD',
      headers: { accept: MANIFEST_TYPES, authorization: `Bearer ${token}` },
      signal,
    });
    const digest = response.headers.get('docker-content-digest');
    if (!response.ok || digest === null) {
      throw new Error(
        `Docker Hub has no image oven/bun:${tag} (HTTP ${response.status})`,
      );
    }
    return digest;
  };
  return (tag) => {
    if (!TAG.test(tag)) {
      return Promise.reject(new Error(`Invalid image tag: ${tag}`));
    }
    const cached = cache.get(tag) ?? attempt(() => resolve(tag));
    cache.set(tag, cached);
    return cached;
  };
};
