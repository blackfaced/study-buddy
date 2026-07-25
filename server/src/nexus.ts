// src/nexus.ts
//
// Minimal client for the local MemoryNexus service (long-term feedback
// engine, runs at http://127.0.0.1:8080 by default). We use a thin,
// dependency-free HTTP layer (fetch) so the rest of study-buddy can
// index/query structured memory without a dedicated SDK.
//
// Design notes:
//  - The fetchFn is injectable so tests can assert the exact request
//    shape and the service can be down without breaking the server
//    (a noop client is the default).
//  - The wire format uses snake_case keys (entity_id, error_type) to
//    match what the MemoryNexus OpenAPI / docs expect.
//  - 404 on a query is treated as "empty result" — this is what
//    the upstream service returns when an entity has no memories yet.

export interface NexusEntry {
  /** Stable identifier of the thing the memory is about (e.g. "child:default"). */
  entityId: string;
  /** Memory kind — keeps the index queryable by category. */
  kind: string;
  /** Human-readable text body. */
  content: string;
  /** Optional structured fields (subject, level, errorType, ts, …). */
  meta?: Record<string, unknown>;
}

export interface NexusQuery {
  entityId?: string;
  kind?: string;
  limit?: number;
}

export interface NexusRecord extends NexusEntry {
  id: string;
  ts?: string;
}

export interface NexusClient {
  /** Index a memory entry. Returns the upstream id. */
  write(entry: NexusEntry): Promise<string>;
  /** Fetch memories matching the query. Returns [] when nothing matches. */
  query(q: NexusQuery): Promise<NexusRecord[]>;
}

/** Build the request path. Exposed for tests and to compose search calls later. */
export function nexusMemoryPath(suffix?: string): string {
  return suffix ? `/memories/${suffix}` : "/memories";
}

export interface NexusClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Optional AbortSignal forwarded from the request. */
  signal?: AbortSignal;
}

export function createNexusClient(opts: NexusClientOptions): NexusClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const auth = `Bearer ${opts.token}`;

  async function write(entry: NexusEntry): Promise<string> {
    const body = {
      entity_id: entry.entityId,
      kind: entry.kind,
      content: entry.content,
      meta: entry.meta ?? {},
    };
    const resp = await fetchFn(`${opts.baseUrl}${nexusMemoryPath()}`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Nexus ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { id: string };
    return data.id;
  }

  async function query(q: NexusQuery): Promise<NexusRecord[]> {
    const params = new URLSearchParams();
    if (q.entityId) params.set("entity_id", q.entityId);
    if (q.kind) params.set("kind", q.kind);
    if (q.limit != null) params.set("limit", String(q.limit));
    const qs = params.toString();
    const url = qs ? `${opts.baseUrl}${nexusMemoryPath()}?${qs}` : `${opts.baseUrl}${nexusMemoryPath()}`;

    const resp = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: auth },
      signal: opts.signal,
    });
    if (resp.status === 404) return [];
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Nexus ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await resp.json()) as NexusRecord[];
    return data;
  }

  return { write, query };
}

/**
 * A noop client used when the service is not configured or unreachable.
 * Indexing a memory returns "noop" and querying returns []. Calls never throw.
 * Lets the rest of the server keep going when Nexus is down.
 */
export function noopNexusClient(): NexusClient {
  return {
    async write() {
      return "noop";
    },
    async query() {
      return [];
    },
  };
}
