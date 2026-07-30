// mcp-server/src/write-tools.test.ts
//
// Integration tests for the two new write-app MCP tools (issue #57 v0.2):
//   - extract_words_from_image
//   - add_words
//
// Both are thin wrappers over the study-buddy HTTP server. We stub
// global fetch with vi.stubGlobal (same pattern as game-tools.test.ts)
// and call handleTool directly.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleTool } from "./tools.js";
import { initDb, getDb } from "./db.js";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

let fetchStub: ReturnType<typeof vi.fn> | null = null;
function stubFetch(impl: (url: string, init: any) => Promise<Response>) {
  fetchStub = vi.fn(impl) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fetchStub);
}
function unstubFetch() {
  if (fetchStub) {
    fetchStub.mockReset();
    fetchStub = null;
  }
  vi.unstubAllGlobals();
}

// Write a real file at /tmp so handleTool's readFile doesn't fail.
// We mock fetch anyway, so the file content is never inspected.
const TMP_PATH = "/tmp/study-buddy-test-photo.jpg";
function setupPhoto() {
  writeFileSync(TMP_PATH, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
}
function cleanupPhoto() {
  if (existsSync(TMP_PATH)) unlinkSync(TMP_PATH);
}

let db: ReturnType<typeof getDb>;

beforeAll(() => {
  initDb(":memory:");
  db = getDb();
});

afterAll(() => {
  db.close();
  cleanupPhoto();
});

afterEach(() => {
  unstubFetch();
  cleanupPhoto();
  // mcp-server's local DB doesn't have writing_attempts / writing_words
  // — those live in study-buddy server's DB. No local cleanup needed.
});

describe("extract_words_from_image (mcp tool, issue #57 v0.2)", () => {
  it("POSTs multipart /api/write/extract-words and returns the words array", async () => {
    setupPhoto();
    let captured: any = null;
    stubFetch(async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ words: ["永", "泳", "远", "处"], model: "MiniMax-M3" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = (await handleTool("extract_words_from_image", {
      imagePath: TMP_PATH,
    })) as { words: string[]; model: string };
    expect(captured.url).toMatch(/\/api\/write\/extract-words$/);
    expect(captured.init.method).toBe("POST");
    expect(captured.init.body).toBeDefined();
    expect(result.words).toEqual(["永", "泳", "远", "处"]);
    expect(result.model).toBe("MiniMax-M3");
  });

  it("returns an empty words array when the server returns 200 with no chars", async () => {
    setupPhoto();
    stubFetch(async () => {
      return new Response(JSON.stringify({ words: [], model: "MiniMax-M3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = (await handleTool("extract_words_from_image", {
      imagePath: TMP_PATH,
    })) as { words: string[]; model: string };
    expect(result.words).toEqual([]);
  });

  it("surfaces a clean error when the server is unreachable", async () => {
    setupPhoto();
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      handleTool("extract_words_from_image", { imagePath: TMP_PATH }),
    ).rejects.toThrow(/fetch failed|ECONNREFUSED/);
  });

  it("surfaces the server's 503 message when vision is not configured", async () => {
    setupPhoto();
    stubFetch(async () => {
      return new Response(
        JSON.stringify({ error: "vision not configured (MINIMAX_API_KEY not set on the server)" }),
        { status: 503 },
      );
    });
    await expect(
      handleTool("extract_words_from_image", { imagePath: TMP_PATH }),
    ).rejects.toThrow(/vision not configured/);
  });

  it("surfaces 400 when the file is not a valid image", async () => {
    setupPhoto();
    stubFetch(async () => {
      return new Response(JSON.stringify({ error: "no image" }), { status: 400 });
    });
    await expect(
      handleTool("extract_words_from_image", { imagePath: TMP_PATH }),
    ).rejects.toThrow(/no image/);
  });

  it("rejects when imagePath is missing", async () => {
    await expect(
      handleTool("extract_words_from_image", {}),
    ).rejects.toThrow(/imagePath/);
  });
});

describe("add_words (mcp tool, issue #57 v0.2)", () => {
  it("POSTs JSON /api/write/words and returns {added, skipped}", async () => {
    let captured: any = null;
    stubFetch(async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ added: 3, skipped: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = (await handleTool("add_words", { chars: "一二三" })) as {
      added: number;
      skipped: number;
    };
    expect(captured.url).toMatch(/\/api\/write\/words$/);
    expect(captured.init.method).toBe("POST");
    // body should be JSON with the chars field
    const body = JSON.parse(captured.init.body);
    expect(body.chars).toBe("一二三");
    expect(result.added).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("passes addedBy when provided", async () => {
    let captured: any = null;
    stubFetch(async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ added: 1, skipped: 0 }), { status: 200 });
    });
    await handleTool("add_words", { chars: "永", addedBy: "agent-vision" });
    const body = JSON.parse(captured.init.body);
    expect(body.addedBy).toBe("agent-vision");
  });

  it("surfaces the server's response faithfully when no chars are added", async () => {
    stubFetch(async () => {
      return new Response(JSON.stringify({ added: 0, skipped: 3 }), { status: 200 });
    });
    const result = (await handleTool("add_words", { chars: "永泳远" })) as {
      added: number;
      skipped: number;
    };
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it("surfaces fetch errors", async () => {
    stubFetch(async () => {
      throw new Error("connect refused");
    });
    await expect(handleTool("add_words", { chars: "永" })).rejects.toThrow();
  });

  it("rejects when chars is missing or not a string", async () => {
    await expect(handleTool("add_words", {})).rejects.toThrow(/chars/);
    await expect(handleTool("add_words", { chars: 123 })).rejects.toThrow(/chars/);
  });
});
