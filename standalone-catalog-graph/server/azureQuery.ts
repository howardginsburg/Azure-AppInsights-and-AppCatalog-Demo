/** Retries only read-only Azure queries on transient network, throttling, and gateway failures. */
export async function azureQuery(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
    } catch (error) {
      const transient = error instanceof TypeError ||
        error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name);
      if (!transient || attempt === 3) throw error;
      console.warn(`Azure query network retry ${attempt}/2:`, error instanceof Error ? error.message : String(error));
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      continue;
    }
    if (![429, 502, 503, 504].includes(response.status) || attempt === 3) return response;
    const retryAfter = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5000, retryAfter * 1000) : attempt * 500;
    console.warn(`Azure query HTTP ${response.status}; retry ${attempt}/2 in ${wait}ms.`);
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error('Azure query retry budget exhausted.');
}
