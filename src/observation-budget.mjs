/** One operator-selected acquisition budget shared by a complete portfolio read. */
export function createObservationBudget(selection, fetchImpl = fetch) {
  if (selection === undefined) return undefined;
  const names = ["maxRequests", "maxDurationMs", "maxResponseBytes", "maxTokenCandidates"];
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)
    || Object.keys(selection).some(name => !names.includes(name))) {
    throw new TypeError("portfolio: acquisitionLimits must contain the four operator limits");
  }
  const limits = Object.freeze(Object.fromEntries(names.map(name => {
    const value = selection[name];
    if (!Number.isSafeInteger(value) || value < 1
      || name === "maxDurationMs" && value > 2_147_483_647
      || name === "maxTokenCandidates" && value > 2048) {
      throw new RangeError(`portfolio: acquisitionLimits.${name} must be a positive bounded integer`);
    }
    return [name, value];
  })));
  if (typeof fetchImpl !== "function") throw new TypeError("portfolio: fetchImpl must be a function");
  const started = performance.now();
  const deadline = new AbortController();
  let requests = 0, closed = false, limited = false;
  const refusal = message => {
    limited = true;
    const error = new Error(message);
    error.name = "ObservationAcquisitionLimitError";
    error.code = "TREASURY_ACQUISITION_LIMIT";
    return error;
  };
  const expire = () => {
    if (!deadline.signal.aborted) deadline.abort(refusal(`portfolio acquisition exceeded ${limits.maxDurationMs} ms`));
  };
  const timer = setTimeout(expire, limits.maxDurationMs);
  const assertAlive = () => {
    if (closed) throw new Error("portfolio acquisition is closed");
    if (performance.now() - started >= limits.maxDurationMs) expire();
    deadline.signal.throwIfAborted();
  };
  const assertAvailable = () => {
    assertAlive();
    if (requests >= limits.maxRequests) throw refusal(`portfolio acquisition reached ${limits.maxRequests} requests`);
  };

  // Receive a cancellation even when a supplied body reader is still pending.
  // The same signal is also passed to the real transport and its body is cancelled.
  const receive = (work, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });

  async function boundedFetch(url, options = {}) {
    assertAvailable();
    requests += 1;
    const local = new AbortController();
    const signal = AbortSignal.any([deadline.signal, local.signal,
      ...(options.signal === undefined ? [] : [options.signal])]);
    let reader;
    try {
      const response = await receive(() => fetchImpl(url, { ...options, redirect: "error", signal }), signal);
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && /^\d+$/u.test(declaredLength)
        && BigInt(declaredLength) > BigInt(limits.maxResponseBytes)) {
        void response.body?.cancel().catch(() => {});
        throw refusal(`portfolio response exceeded ${limits.maxResponseBytes} bytes`);
      }
      reader = response.body?.getReader();
      const chunks = [];
      let length = 0;
      if (reader !== undefined) for (;;) {
        const { done, value } = await receive(() => reader.read(), signal);
        if (done) break;
        length += value.byteLength;
        if (length > limits.maxResponseBytes) throw refusal(`portfolio response exceeded ${limits.maxResponseBytes} bytes`);
        chunks.push(value);
      }
      assertAlive();
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      // Original readers still consume a native Response. Its JSON bytes have
      // already passed the whole-observation deadline and response-size bound.
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } catch (error) {
      local.abort(error);
      if (reader !== undefined) void reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      try { reader?.releaseLock(); } catch { /* A cancelled pending read releases its own lock. */ }
    }
  }

  return Object.freeze({
    limits, fetch: boundedFetch, assertAvailable,
    async sleep(milliseconds) {
      assertAvailable();
      let waiting;
      try {
        await receive(() => new Promise(resolve => { waiting = setTimeout(resolve, milliseconds); }), deadline.signal);
      } finally { clearTimeout(waiting); }
    },
    get limited() { return limited; },
    close() { closed = true; clearTimeout(timer); deadline.abort(new Error("portfolio acquisition is closed")); },
  });
}
