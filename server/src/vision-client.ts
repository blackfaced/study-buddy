// src/vision-client.ts
//
// v0.5: production VisionClient that talks to MiniMax M3's
// /v1/vl/chat/completions endpoint. Kept as a separate class from
// ./vision.ts so the pure prompt + parse functions stay testable without
// network, and so we can swap models / providers later without touching
// the route handler.

import type { VisionClient } from "./vision.js";

export interface MiniMaxVisionClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** AbortSignal forwarded from the request so client disconnects cancel the call. */
  signal?: AbortSignal;
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}

export class MiniMaxVisionClient implements VisionClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly signal?: AbortSignal;

  constructor(opts: MiniMaxVisionClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "MiniMax-M3";
    this.baseUrl = opts.baseUrl ?? "https://api.minimaxi.com/v1/vl/chat/completions";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.signal = opts.signal;
  }

  async chat(params: { system: string; user: string; imageBase64: string }): Promise<{
    content: string;
    raw: unknown;
  }> {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: params.system },
        {
          role: "user",
          content: [
            { type: "text", text: params.user },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${params.imageBase64}` },
            },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 800,
    };

    const resp = await this.fetchFn(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: this.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`vision API ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as ChatResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    return { content, raw: data };
  }
}
