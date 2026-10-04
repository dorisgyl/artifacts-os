// Model calls for edge agents.
//
// The main model goes through AI Gateway's OpenAI-compatible endpoint, so the
// provider key lives at the gateway and this Worker carries only a gateway
// token. Without a gateway the fallback model runs on Workers AI directly.
// Either way the agent gets JSON back and nothing else: free text is where
// recordings stop being reproducible.

import type { Env } from "../env.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Completion {
  text: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  ms: number;
}

export async function complete(
  env: Env,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<Completion> {
  const started = Date.now();
  const temperature = opts.temperature ?? 0.1;
  const maxTokens = opts.maxTokens ?? 8000;

  if (env.CF_ACCOUNT_ID && env.AI_GATEWAY_TOKEN && env.MODEL) {
    const url =
      "https://gateway.ai.cloudflare.com/v1/" +
      env.CF_ACCOUNT_ID +
      "/" +
      (env.AI_GATEWAY_NAME || "default") +
      "/compat/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-aig-authorization": "Bearer " + env.AI_GATEWAY_TOKEN,
      },
      body: JSON.stringify({
        model: env.MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error("model call failed: " + res.status + " " + (await res.text()).slice(0, 300));
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices[0].message.content,
      model: env.MODEL,
      tokensIn: body.usage?.prompt_tokens,
      tokensOut: body.usage?.completion_tokens,
      ms: Date.now() - started,
    };
  }

  const model = env.FALLBACK_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const out = (await env.AI.run(model as Parameters<Ai["run"]>[0], {
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  } as never)) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const text = typeof out.response === "string" ? out.response : JSON.stringify(out.response ?? out);
  return {
    text,
    model,
    tokensIn: out.usage?.prompt_tokens,
    tokensOut: out.usage?.completion_tokens,
    ms: Date.now() - started,
  };
}

/** The first JSON object in a model reply, tolerating code fences and chatter. */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model reply");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export async function completeJson<T>(
  env: Env,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<{ value: T; completion: Completion }> {
  const completion = await complete(env, messages, opts);
  return { value: parseJson<T>(completion.text), completion };
}
