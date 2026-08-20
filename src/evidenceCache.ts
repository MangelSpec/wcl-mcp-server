import { AsyncLocalStorage } from "node:async_hooks";

export const EVIDENCE_CACHE_LIMITS = {
  maxBytes: 32 * 1024 * 1024,
  maxEntries: 128,
  maxEntryBytes: 4 * 1024 * 1024,
  maxInflight: 32,
} as const;

const EVIDENCE_CACHE_MAXIMUMS = {
  maxBytes: 1024 * 1024 * 1024,
  maxEntries: 1024,
  maxEntryBytes: 1024 * 1024 * 1024,
} as const;

export const EVIDENCE_TTLS = {
  context: 60_000,
  events: 30_000,
  table: 60_000,
} as const;

export type EvidenceOperation = keyof typeof EVIDENCE_TTLS;
export type CacheOutcome =
  | "hit"
  | "miss"
  | "coalesced"
  | "refresh"
  | "bypass"
  | "skip_oversize"
  | "load_error"
  | "evicted";

export interface CacheEvent {
  cache: "evidence";
  source: "wcl";
  operation: EvidenceOperation;
  outcome: CacheOutcome;
  durationMs?: number;
  decodedBytes?: number;
  retainedBytes?: number;
}

interface CompletedEntry {
  bytes: number;
  expiresAt: number;
  json: string;
}

interface InflightEntry {
  controller: AbortController;
  metricsClaimed: boolean;
  promise: Promise<LoadedValue>;
}

interface LoadedValue {
  decodedBytes: number;
  evicted: boolean;
  json: string | null;
  upstreamDurationMs: number;
  value: unknown;
}

class EvidenceLoadError extends Error {
  constructor(
    readonly original: unknown,
    readonly metrics?: {
      decodedBytes: number;
      upstreamDurationMs: number;
    },
  ) {
    super(original instanceof Error ? original.message : String(original), {
      cause: original,
    });
    this.name = "EvidenceLoadError";
  }
}

export interface EvidenceCacheOptions {
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxInflight: number;
  now?: () => number;
  observer?: (event: CacheEvent) => void;
}

export interface LoadEvidenceOptions<T> {
  key: unknown;
  loader: (
    signal: AbortSignal,
    observeUpstream: (metrics: {
      decodedBytes: number;
      durationMs: number;
    }) => void,
  ) => Promise<T>;
  operation: EvidenceOperation;
  refresh?: boolean;
  signal?: AbortSignal;
  ttlMs?: number;
}

const telemetry = new AsyncLocalStorage<CacheEvent[]>();
const localCounters = new Map<CacheOutcome, number>();

export class EvidenceCache {
  readonly #completed = new Map<string, CompletedEntry>();
  readonly #inflight = new Map<string, InflightEntry>();
  readonly #ownedControllers = new Set<AbortController>();
  readonly #options: Required<Omit<EvidenceCacheOptions, "observer">> & {
    observer?: (event: CacheEvent) => void;
  };
  #bytes = 0;
  #latestNow = Number.NEGATIVE_INFINITY;
  #shutdown = false;
  #warnedObserver = false;

  constructor(options: EvidenceCacheOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (name === "now" || name === "observer") continue;
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
    this.#options = { ...options, now: options.now ?? Date.now };
  }

  async load<T>(options: LoadEvidenceOptions<T>): Promise<T> {
    if (this.#shutdown) {
      return Promise.reject(abortError());
    }

    const key = canonicalJson(options.key);
    if (key === null) return this.#loadUncached(options, "bypass");

    if (options.refresh === true) this.#deleteCompleted(key);

    const now = this.#monotonicNow();
    const completed = this.#completed.get(key);
    if (completed && now < completed.expiresAt && options.refresh !== true) {
      this.#completed.delete(key);
      this.#completed.set(key, completed);
      this.#emit({
        cache: "evidence",
        operation: options.operation,
        outcome: "hit",
        retainedBytes: completed.bytes,
        source: "wcl",
      });
      return cloneJson<T>(completed.json);
    }
    if (completed) this.#deleteCompleted(key);

    const pending = this.#inflight.get(key);
    if (pending) {
      try {
        const loaded = await waitForCaller(pending.promise, options.signal);
        const metrics = claimLoadedMetrics(pending, loaded);
        this.#emit({
          cache: "evidence",
          ...(metrics === undefined
            ? {}
            : {
                decodedBytes: metrics.decodedBytes,
                durationMs: metrics.upstreamDurationMs,
              }),
          operation: options.operation,
          outcome: "coalesced",
          source: "wcl",
        });
        return cloneLoaded<T>(loaded);
      } catch (error) {
        const metrics = claimFailureMetrics(pending, error);
        this.#emit({
          cache: "evidence",
          ...(metrics === undefined
            ? {}
            : {
                decodedBytes: metrics.decodedBytes,
                durationMs: metrics.upstreamDurationMs,
              }),
          operation: options.operation,
          outcome: "load_error",
          source: "wcl",
        });
        throw unwrapLoadError(error);
      }
    }

    if (this.#inflight.size >= this.#options.maxInflight) {
      return this.#loadUncached(options, "bypass");
    }

    const controller = new AbortController();
    this.#ownedControllers.add(controller);
    const startedAt = this.#monotonicNow();
    const promise = this.#runLoader(options.loader, controller)
      .then((loaded) => {
        if (this.#shutdown || loaded.json === null) return loaded;
        const bytes = Buffer.byteLength(key) + Buffer.byteLength(loaded.json);
        if (
          bytes > this.#options.maxEntryBytes ||
          bytes > this.#options.maxBytes
        ) {
          return loaded;
        }
        this.#deleteCompleted(key);
        this.#completed.set(key, {
          bytes,
          expiresAt:
            this.#monotonicNow() +
            (options.ttlMs ?? EVIDENCE_TTLS[options.operation]),
          json: loaded.json,
        });
        this.#bytes += bytes;
        loaded.evicted = this.#evictToBounds();
        return loaded;
      })
      .finally(() => {
        this.#inflight.delete(key);
        this.#ownedControllers.delete(controller);
      });

    const inflight = { controller, metricsClaimed: false, promise };
    this.#inflight.set(key, inflight);
    try {
      const loaded = await waitForCaller(promise, options.signal);
      const retained = this.#completed.get(key)?.bytes;
      const metrics = claimLoadedMetrics(inflight, loaded);
      this.#emit({
        cache: "evidence",
        ...(metrics === undefined
          ? {}
          : {
              decodedBytes: metrics.decodedBytes,
              durationMs: metrics.upstreamDurationMs,
            }),
        operation: options.operation,
        outcome:
          loaded.evicted
            ? "evicted"
            : retained === undefined
              ? loaded.json === null
                ? "bypass"
                : "skip_oversize"
              : options.refresh === true
                ? "refresh"
                : "miss",
        ...(retained === undefined ? {} : { retainedBytes: retained }),
        source: "wcl",
      });
      return cloneLoaded<T>(loaded);
    } catch (error) {
      const failure = claimFailureMetrics(inflight, error);
      this.#emit({
        cache: "evidence",
        ...(failure === undefined
          ? {}
          : { decodedBytes: failure.decodedBytes }),
        durationMs:
          failure?.upstreamDurationMs ??
          Math.max(0, this.#monotonicNow() - startedAt),
        operation: options.operation,
        outcome: "load_error",
        source: "wcl",
      });
      throw unwrapLoadError(error);
    }
  }

  clear(): void {
    this.#completed.clear();
    this.#bytes = 0;
  }

  shutdown(): void {
    this.#shutdown = true;
    this.clear();
    for (const controller of this.#ownedControllers) controller.abort();
    this.#inflight.clear();
  }

  snapshot(): {
    bytes: number;
    entries: number;
    inflight: number;
    shutdown: boolean;
  } {
    return {
      bytes: this.#bytes,
      entries: this.#completed.size,
      inflight: this.#inflight.size,
      shutdown: this.#shutdown,
    };
  }

  async #loadUncached<T>(
    options: LoadEvidenceOptions<T>,
    outcome: CacheOutcome,
  ): Promise<T> {
    const controller = new AbortController();
    this.#ownedControllers.add(controller);
    const startedAt = this.#monotonicNow();
    const promise = this.#runLoader(options.loader, controller).finally(() => {
      this.#ownedControllers.delete(controller);
    });
    try {
      const loaded = await waitForCaller(promise, options.signal);
      this.#emit({
        cache: "evidence",
        decodedBytes: loaded.decodedBytes,
        durationMs: loaded.upstreamDurationMs,
        operation: options.operation,
        outcome,
        source: "wcl",
      });
      return cloneLoaded<T>(loaded);
    } catch (error) {
      const failure = loadFailureMetrics(error)?.metrics;
      this.#emit({
        cache: "evidence",
        ...(failure === undefined
          ? {}
          : { decodedBytes: failure.decodedBytes }),
        durationMs:
          failure?.upstreamDurationMs ??
          Math.max(0, this.#monotonicNow() - startedAt),
        operation: options.operation,
        outcome: "load_error",
        source: "wcl",
      });
      throw unwrapLoadError(error);
    }
  }

  async #runLoader<T>(
    loader: LoadEvidenceOptions<T>["loader"],
    controller: AbortController,
  ): Promise<LoadedValue> {
    let decodedBytes = 0;
    let upstreamDurationMs = 0;
    let observedUpstream = false;
    try {
      const value = await waitForCaller(
        loader(controller.signal, (metrics) => {
          observedUpstream = true;
          decodedBytes += metrics.decodedBytes;
          upstreamDurationMs += metrics.durationMs;
        }),
        controller.signal,
      );
      return {
        decodedBytes,
        evicted: false,
        json: jsonValue(value),
        upstreamDurationMs,
        value,
      };
    } catch (error) {
      throw new EvidenceLoadError(
        error,
        observedUpstream ? { decodedBytes, upstreamDurationMs } : undefined,
      );
    }
  }

  #deleteCompleted(key: string): void {
    const existing = this.#completed.get(key);
    if (!existing) return;
    this.#completed.delete(key);
    this.#bytes -= existing.bytes;
  }

  #monotonicNow(): number {
    const now = this.#options.now();
    this.#latestNow = Math.max(this.#latestNow, now);
    return this.#latestNow;
  }

  #evictToBounds(): boolean {
    let evicted = false;
    while (
      this.#completed.size > this.#options.maxEntries ||
      this.#bytes > this.#options.maxBytes
    ) {
      const oldest = this.#completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#deleteCompleted(oldest);
      evicted = true;
    }
    return evicted;
  }

  #emit(event: CacheEvent): void {
    try {
      this.#options.observer?.(event);
    } catch {
      if (!this.#warnedObserver) {
        this.#warnedObserver = true;
        console.error(
          "WCL evidence cache observer failed; further warnings suppressed",
        );
      }
    }
  }
}

export function parseEvidenceCacheLimits(
  environment: Record<string, string | undefined> = process.env,
): Omit<EvidenceCacheOptions, "now" | "observer"> {
  return {
    maxBytes: parseEvidenceCacheLimit(
      "WCL_EVIDENCE_CACHE_MAX_BYTES",
      environment.WCL_EVIDENCE_CACHE_MAX_BYTES,
      EVIDENCE_CACHE_LIMITS.maxBytes,
      EVIDENCE_CACHE_MAXIMUMS.maxBytes,
    ),
    maxEntries: parseEvidenceCacheLimit(
      "WCL_EVIDENCE_CACHE_MAX_ENTRIES",
      environment.WCL_EVIDENCE_CACHE_MAX_ENTRIES,
      EVIDENCE_CACHE_LIMITS.maxEntries,
      EVIDENCE_CACHE_MAXIMUMS.maxEntries,
    ),
    maxEntryBytes: parseEvidenceCacheLimit(
      "WCL_EVIDENCE_CACHE_MAX_ENTRY_BYTES",
      environment.WCL_EVIDENCE_CACHE_MAX_ENTRY_BYTES,
      EVIDENCE_CACHE_LIMITS.maxEntryBytes,
      EVIDENCE_CACHE_MAXIMUMS.maxEntryBytes,
    ),
    maxInflight: EVIDENCE_CACHE_LIMITS.maxInflight,
  };
}

function parseEvidenceCacheLimit(
  name: string,
  value: string | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return defaultValue;
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

const sharedCache = new EvidenceCache({
  ...parseEvidenceCacheLimits(),
  observer: observeEvidenceEvent,
});

export function loadEvidence<T>(options: LoadEvidenceOptions<T>): Promise<T> {
  return sharedCache.load(options);
}

export function clearEvidenceCache(): void {
  sharedCache.clear();
}

export function shutdownEvidenceCache(): void {
  sharedCache.shutdown();
}

export function getEvidenceCacheStats(): Readonly<
  Record<CacheOutcome, number>
> {
  return Object.freeze(
    Object.fromEntries(
      [
        "hit",
        "miss",
        "coalesced",
        "refresh",
        "bypass",
        "skip_oversize",
        "load_error",
        "evicted",
      ].map((outcome) => [
        outcome,
        localCounters.get(outcome as CacheOutcome) ?? 0,
      ]),
    ) as Record<CacheOutcome, number>,
  );
}

export function withEvidenceTelemetry<T>(
  callback: () => Promise<T>,
): Promise<T> {
  return telemetry.run([], callback);
}

export function getEvidenceResultMeta(): Record<string, unknown> | undefined {
  const events = telemetry.getStore();
  return events && events.length > 0
    ? { "raidlens/cache": { events: [...events] } }
    : undefined;
}

export function canonicalJson(value: unknown): string | null {
  try {
    return JSON.stringify(normalizeJson(value, new Set())) ?? null;
  } catch {
    return null;
  }
}

function observeEvidenceEvent(event: CacheEvent): void {
  localCounters.set(event.outcome, (localCounters.get(event.outcome) ?? 0) + 1);
  const events = telemetry.getStore();
  if (events && events.length < 64) {
    events.push(event);
  }
}

function jsonValue(value: unknown): string | null {
  try {
    normalizeJson(value, new Set());
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function normalizeJson(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new Error("Unsupported JSON value");
  if (ancestors.has(value)) throw new Error("Cyclic JSON value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value) || value[index] === undefined) {
          throw new Error("Sparse or undefined array entry");
        }
        output.push(normalizeJson(value[index], ancestors));
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Non-JSON object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("Symbol-keyed property");
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      output[key] = normalizeJson(record[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJson<T>(json: string): T {
  return JSON.parse(json) as T;
}

function cloneLoaded<T>(loaded: LoadedValue): T {
  return loaded.json === null ? (loaded.value as T) : cloneJson<T>(loaded.json);
}

function loadFailureMetrics(error: unknown): EvidenceLoadError | undefined {
  return error instanceof EvidenceLoadError ? error : undefined;
}

function claimLoadedMetrics(
  inflight: InflightEntry,
  loaded: LoadedValue,
): LoadedValue | undefined {
  if (inflight.metricsClaimed) return undefined;
  inflight.metricsClaimed = true;
  return loaded;
}

function claimFailureMetrics(
  inflight: InflightEntry,
  error: unknown,
): { decodedBytes: number; upstreamDurationMs: number } | undefined {
  const failure = loadFailureMetrics(error);
  if (!failure?.metrics || inflight.metricsClaimed) return undefined;
  inflight.metricsClaimed = true;
  return failure.metrics;
}

function unwrapLoadError(error: unknown): unknown {
  return error instanceof EvidenceLoadError ? error.original : error;
}

function waitForCaller<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
