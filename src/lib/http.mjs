const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function getJson(url, options = {}) {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'AxiomForwardLab/0.1 (paper-research)',
          ...options.headers,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const error = new Error(`${response.status} ${response.statusText} for ${url}`);
        error.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1_000 : null;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = error.retryAfterMs ?? baseDelayMs * attempt;
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

export { sleep };

