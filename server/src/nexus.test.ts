import { describe, it, expect, vi } from "vitest";
import {
  createNexusClient,
  nexusMemoryPath,
  type NexusEntry,
  type NexusClient,
} from "./nexus.js";

function mockFetch(impl: (url: string, init: any) => Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

const SAMPLE_ENTRY: NexusEntry = {
  entityId: "child:default",
  kind: "math_mistake",
  content: "错题 5+7=11,实际是 12,错误类型:carry",
  meta: { level: 1, errorType: "carry", subject: "math" },
};

describe("createNexusClient", () => {
  it("writes a memory entry to POST {baseUrl}/memories with bearer auth", async () => {
    let captured: { url: string; init: any } | null = null;
    const fetchFn = mockFetch(async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: "mem-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createNexusClient({
      baseUrl: "http://127.0.0.1:8080",
      token: "test-token",
      fetchFn,
    });
    const id = await client.write(SAMPLE_ENTRY);
    expect(id).toBe("mem-1");
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://127.0.0.1:8080/memories");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.headers.Authorization).toBe("Bearer test-token");
    expect(captured!.init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(captured!.init.body);
    expect(body).toEqual({
      entity_id: "child:default",
      kind: "math_mistake",
      content: SAMPLE_ENTRY.content,
      meta: SAMPLE_ENTRY.meta,
    });
  });

  it("queries memories by entity + kind with GET + query string", async () => {
    let captured: { url: string; init: any } | null = null;
    const fetchFn = mockFetch(async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify([{ id: "m1", content: "x" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createNexusClient({
      baseUrl: "http://127.0.0.1:8080",
      token: "t",
      fetchFn,
    });
    const results = await client.query({ entityId: "child:default", kind: "math_mistake", limit: 5 });
    expect(results).toEqual([{ id: "m1", content: "x" }]);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(
      "http://127.0.0.1:8080/memories?entity_id=child%3Adefault&kind=math_mistake&limit=5"
    );
    expect(captured!.init.method).toBe("GET");
  });

  it("returns an empty array when query returns 404 (entity has no memories yet)", async () => {
    const fetchFn = mockFetch(async () => {
      return new Response("not found", { status: 404 });
    });
    const client = createNexusClient({ baseUrl: "http://x", token: "t", fetchFn });
    const results = await client.query({ entityId: "child:default", kind: "math_mistake" });
    expect(results).toEqual([]);
  });

  it("throws on a non-2xx response other than 404 with the truncated body in the message", async () => {
    const fetchFn = mockFetch(async () => {
      return new Response("boom", { status: 500 });
    });
    const client = createNexusClient({ baseUrl: "http://x", token: "t", fetchFn });
    await expect(client.write(SAMPLE_ENTRY)).rejects.toThrow(/Nexus 500/);
  });

  it("query with no filters hits /memories (no query string)", async () => {
    let captured: { url: string } | null = null;
    const fetchFn = mockFetch(async (url) => {
      captured = { url };
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = createNexusClient({ baseUrl: "http://x", token: "t", fetchFn });
    await client.query({});
    expect(captured!.url).toBe("http://x/memories");
  });
});

describe("nexusMemoryPath", () => {
  it("returns /memories (default)", () => {
    expect(nexusMemoryPath()).toBe("/memories");
  });
  it("appends a path segment when given", () => {
    expect(nexusMemoryPath("search")).toBe("/memories/search");
  });
});

// Reference the NexusClient type so TS doesn't strip the import.
export type _NexusClientRef = NexusClient;
