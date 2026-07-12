import { describe, expect, it, vi } from "vitest";
import { MiniMaxVisionClient } from "./vision-client.js";

function mockFetch(impl: (url: string, init: any) => Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("MiniMaxVisionClient", () => {
  it("POSTs to /v1/vl/chat/completions with bearer auth", async () => {
    let captured: { url: string; init: any } | null = null;
    const fetchFn = mockFetch(async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "题目：x\n思路：y" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const client = new MiniMaxVisionClient({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1/vl/chat/completions",
      fetchFn,
    });

    await client.chat({ system: "S", user: "U", imageBase64: "B64" });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://example.test/v1/vl/chat/completions");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.headers.Authorization).toBe("Bearer test-key");
    expect(captured!.init.headers["Content-Type"]).toBe("application/json");
  });

  it("embeds the image as a base64 data URL in the OpenAI-compatible content array", async () => {
    let captured: any = null;
    const fetchFn = mockFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "题目：x\n思路：y" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const client = new MiniMaxVisionClient({ apiKey: "k", fetchFn });
    await client.chat({ system: "SYS", user: "USR", imageBase64: "DEADBEEF" });

    expect(captured.model).toBe("MiniMax-M3");
    expect(captured.messages).toHaveLength(2);
    expect(captured.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(captured.messages[1].role).toBe("user");
    expect(captured.messages[1].content).toEqual([
      { type: "text", text: "USR" },
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,DEADBEEF" },
      },
    ]);
  });

  it("returns the assistant content + raw response", async () => {
    const fetchFn = mockFetch(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "题目：1+1\n思路：数一数" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const client = new MiniMaxVisionClient({ apiKey: "k", fetchFn });
    const { content, raw } = await client.chat({
      system: "S", user: "U", imageBase64: "B",
    });
    expect(content).toBe("题目：1+1\n思路：数一数");
    expect((raw as any).usage.prompt_tokens).toBe(100);
  });

  it("returns empty content if the response has no choices", async () => {
    const fetchFn = mockFetch(async () => {
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new MiniMaxVisionClient({ apiKey: "k", fetchFn });
    const { content } = await client.chat({ system: "S", user: "U", imageBase64: "B" });
    expect(content).toBe("");
  });

  it("throws on non-2xx response with status + truncated body", async () => {
    const fetchFn = mockFetch(async () => {
      return new Response("internal error", { status: 500 });
    });
    const client = new MiniMaxVisionClient({ apiKey: "k", fetchFn });
    await expect(
      client.chat({ system: "S", user: "U", imageBase64: "B" })
    ).rejects.toThrow(/vision API 500/);
  });

  it("supports overriding the model", async () => {
    let captured: any = null;
    const fetchFn = mockFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new MiniMaxVisionClient({
      apiKey: "k",
      model: "MiniMax-M2.7",
      fetchFn,
    });
    await client.chat({ system: "S", user: "U", imageBase64: "B" });
    expect(captured.model).toBe("MiniMax-M2.7");
  });
});
