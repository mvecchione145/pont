import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import OpenAI from 'openai';
import { z } from 'zod';
import type { LlmSettings } from './settings.js';

// One structured-output call to the configured LLM: Claude through the
// official Anthropic SDK (structured outputs), or any OpenAI-compatible
// endpoint (JSON schema response format, falling back to plain JSON mode).
// Both paths validate the result against the same Zod schema and map
// provider errors to messages people can act on.

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502 | 503 = 502,
  ) {
    super(message);
  }
}

// Server-side refusal fallbacks and effort apply to current Claude models on
// Anthropic's API; skip them for older models and custom endpoints.
export const supportsFallbacks = (model: string) => /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
export const supportsEffort = (model: string) => /^claude-(opus-5|fable-5|sonnet-5|opus-4-[5-8]|sonnet-4-6)/.test(model);

export interface StructuredRequest<S extends z.ZodType> {
  system: string;
  user: string;
  schema: S;
  // Name for the schema (OpenAI-compatible endpoints require one).
  name: string;
  effort: 'low' | 'medium' | 'high';
  // Let Claude think before answering (adaptive thinking), for harder tasks.
  thinking?: boolean;
  maxTokens?: number;
  // Shown when the model declines or the output is cut off, e.g. "write a question".
  task: string;
}

export interface StructuredResult<T> {
  data: T;
  usage: { inputTokens: number; outputTokens: number };
}

async function withAnthropic<S extends z.ZodType>(
  settings: LlmSettings,
  req: StructuredRequest<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const client = new Anthropic({ apiKey: settings.apiKey, baseURL: settings.baseUrl || undefined });
  const official = !settings.baseUrl;
  const modern = supportsEffort(settings.model);
  try {
    const message = await client.beta.messages.parse({
      model: settings.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      ...(req.thinking && modern ? { thinking: { type: 'adaptive' as const } } : {}),
      output_config: {
        format: betaZodOutputFormat(req.schema),
        ...(modern ? { effort: req.effort } : {}),
      },
      ...(official && supportsFallbacks(settings.model)
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    });
    if (message.stop_reason === 'refusal') throw new LlmError(`The model declined to ${req.task}.`);
    if (message.stop_reason === 'max_tokens' || !message.parsed_output) {
      throw new LlmError(`The model's answer was cut off before it could ${req.task}. Try again.`);
    }
    const parsed = req.schema.safeParse(message.parsed_output);
    if (!parsed.success) throw new LlmError(`The model returned a malformed answer. Try again.`);
    return {
      data: parsed.data,
      usage: {
        inputTokens:
          message.usage.input_tokens +
          (message.usage.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      },
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new LlmError('Anthropic rejected the API key. Check it in Settings.', 400);
    if (err instanceof Anthropic.NotFoundError) throw new LlmError(`Model "${settings.model}" was not found. Check it in Settings.`, 400);
    if (err instanceof Anthropic.BadRequestError) throw new LlmError(`Anthropic rejected the request: ${err.message}`, 400);
    if (err instanceof Anthropic.RateLimitError) throw new LlmError('Rate limited by Anthropic. Try again in a moment.', 503);
    if (err instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error (${err.status ?? 'network'}): ${err.message}`);
    throw err;
  }
}

async function withOpenAiCompatible<S extends z.ZodType>(
  settings: LlmSettings,
  req: StructuredRequest<S>,
): Promise<StructuredResult<z.infer<S>>> {
  // Local servers such as Ollama accept any key.
  const client = new OpenAI({ apiKey: settings.apiKey || 'not-needed', baseURL: settings.baseUrl || undefined });
  const schema = z.toJSONSchema(req.schema);
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: `${req.user}\n\nRespond with JSON matching the schema.` },
  ];
  try {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: settings.model,
        messages,
        response_format: { type: 'json_schema', json_schema: { name: req.name, schema } },
      });
    } catch (err) {
      // Some OpenAI-compatible servers only support plain JSON mode.
      if (!(err instanceof OpenAI.BadRequestError)) throw err;
      messages[1] = {
        role: 'user',
        content: `${req.user}\n\nRespond with only a JSON object matching this JSON schema:\n${JSON.stringify(schema)}`,
      };
      completion = await client.chat.completions.create({
        model: settings.model,
        messages,
        response_format: { type: 'json_object' },
      });
    }
    const text = completion.choices[0]?.message?.content;
    if (!text) throw new LlmError('The model returned an empty response. Try again.');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmError('The model did not return valid JSON. Try again.');
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new LlmError('The model returned a malformed answer. Try again.');
    return {
      data: parsed.data,
      usage: { inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0 },
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof OpenAI.AuthenticationError) throw new LlmError('The provider rejected the API key. Check it in Settings.', 400);
    if (err instanceof OpenAI.NotFoundError) throw new LlmError(`Model "${settings.model}" was not found. Check it in Settings.`, 400);
    if (err instanceof OpenAI.RateLimitError) throw new LlmError('Rate limited by the provider. Try again in a moment.', 503);
    if (err instanceof OpenAI.APIConnectionError) throw new LlmError(`Could not reach ${settings.baseUrl || 'the provider'}.`, 503);
    if (err instanceof OpenAI.APIError) throw new LlmError(`Provider error (${err.status ?? 'network'}): ${err.message}`);
    throw err;
  }
}

export function structured<S extends z.ZodType>(
  settings: LlmSettings,
  req: StructuredRequest<S>,
): Promise<StructuredResult<z.infer<S>>> {
  return settings.provider === 'anthropic' ? withAnthropic(settings, req) : withOpenAiCompatible(settings, req);
}
