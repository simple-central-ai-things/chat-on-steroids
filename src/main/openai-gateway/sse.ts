/**
 * Server-Sent Events for `stream: true` chat completions.
 *
 * Two owners, both dependency-free so node:test can drive them with a stub
 * response: `SseWriter` owns the socket (framing, ordering, backpressure,
 * disconnect detection and the keep-alive comment), and the `chunk` builders
 * own the OpenAI `chat.completion.chunk` wire shape.
 *
 * Two properties matter and are the reason this is not a bare `res.write`:
 *
 *  - ONE frame at a time. Every frame goes through the same serialized queue,
 *    so a delta and a keep-alive comment can never interleave inside a frame.
 *  - WRITES ARE AWAITED. When the client stops reading, `res.write` returns
 *    false and the queue waits for 'drain'; the turn follower therefore waits
 *    with it instead of buffering an unbounded answer in this process.
 */
import type { ServerResponse } from 'node:http';

/** One `chat.completion.chunk` identity, shared by every chunk of a turn. */
export interface CompletionChunkMeta {
  id: string;
  created: number;
  model: string;
}

/** A delta object in an OpenAI chunk: role first, then content pieces. */
export interface ChunkDelta {
  role?: 'assistant';
  content?: string;
}

/**
 * One OpenAI-shaped `chat.completion.chunk`. `finish_reason` is null on every
 * delta and 'stop' only on the closing chunk, whose delta is empty.
 */
export function completionChunk(
  meta: CompletionChunkMeta,
  delta: ChunkDelta,
  finishReason: 'stop' | null = null,
): {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChunkDelta;
    logprobs: null;
    finish_reason: 'stop' | null;
  }>;
} {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }]
  };
}

/** The end of an OpenAI event stream. Never sent after an error frame. */
export const STREAM_DONE = 'data: [DONE]\n\n';

/**
 * Writes `text/event-stream` frames in order and reports a client disconnect.
 *
 * A disconnect is only the client leaving before the stream finished: the
 * normal `close` that follows our own `end()` is not one, so the caller can
 * distinguish "nobody wants this answer" from "sent".
 */
export class SseWriter {
  private readonly res: ServerResponse;
  private readonly onDisconnect: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private gone = false;
  private closing = false;
  private finishing = false;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(res: ServerResponse, options: { onDisconnect?: () => void } = {}) {
    this.res = res;
    this.onDisconnect = options.onDisconnect;
    // A response can emit 'error' (ECONNRESET, write after end). Without a
    // listener that is an uncaught exception in the app process.
    res.on('error', () => { this.gone = true; });
    res.on('close', () => {
      const wasFinishing = this.finishing;
      this.gone = true;
      this.stopHeartbeat();
      if (!wasFinishing) this.onDisconnect?.();
    });
  }

  /** True once the client left (or the socket broke) before we finished. */
  get disconnected(): boolean {
    return this.gone && !this.finishing;
  }

  /** True once nothing more can be written (either side ended the stream). */
  get closed(): boolean {
    return this.gone || this.finishing || this.res.writableEnded || this.res.destroyed;
  }

  /** One `data:` frame carrying an OpenAI-shaped JSON payload. */
  send(payload: unknown): Promise<void> {
    return this.frame(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /** Raw frame text (only `data: [DONE]` uses this). */
  raw(text: string): Promise<void> {
    return this.frame(text);
  }

  /**
   * A comment frame. CoS turns can think for minutes without recording a
   * revision; a comment keeps intermediaries (LiteLLM, a reverse proxy) from
   * treating the quiet socket as a dead one. SSE clients ignore comments.
   */
  comment(text: string): Promise<void> {
    return this.frame(`: ${text}\n\n`);
  }

  /** Start the periodic comment; a no-op for a non-positive interval. */
  startHeartbeat(ms: number, text = 'keep-alive'): void {
    if (ms <= 0 || this.heartbeat !== null || this.closed) return;
    this.heartbeat = setInterval(() => { void this.comment(text); }, ms);
    this.heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Flush everything queued, then end the response once. */
  async close(): Promise<void> {
    this.stopHeartbeat();
    // Refuse new frames, but let the ones already queued reach the socket:
    // they were accepted before the caller asked to finish.
    this.closing = true;
    await this.queue;
    this.finishing = true;
    if (!this.res.writableEnded && !this.res.destroyed) this.res.end();
  }

  /**
   * Queue one frame behind the ones already queued. The returned promise
   * always resolves: a write failure is the disconnect flag's business, not
   * an exception in the turn follower.
   */
  private frame(text: string): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.queue = this.queue.then(() => this.write(text)).catch(() => undefined);
    return this.queue;
  }

  /** Write one frame, waiting for 'drain' when the socket pushes back. */
  private write(text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.res.off('drain', done);
        this.res.off('close', done);
        this.res.off('error', done);
        resolve();
      };
      let accepted: boolean;
      try {
        accepted = this.res.write(text);
      } catch {
        this.gone = true;
        done();
        return;
      }
      if (accepted) {
        done();
        return;
      }
      // The high-water mark was reached: wait for the client to read (or for
      // the socket to die, which must not leave this promise pending).
      this.res.once('drain', done);
      this.res.once('close', done);
      this.res.once('error', done);
    });
  }
}
