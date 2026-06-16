// Streaming variant of the screening_to_opd agent turn.
//
// Calls the Lovable AI gateway with stream:true, incrementally extracts the
// `agent_reply` field from the JSON object, and yields sentence chunks to the
// caller as soon as a sentence boundary is detected. After the LLM stream
// completes, the full structured AgentResult is emitted as the `final` chunk.
//
// Used by /api/public/agent/turn-stream so the bridge can start TTS on the
// first sentence while the LLM is still generating the rest of the reply.
//
// Best-effort: if streaming/parsing fails at any point, the caller falls back
// to the legacy non-streaming /api/public/agent/turn endpoint.

import type { AgentResult } from "@/routes/api.public.agent.turn";

export type StreamChunk =
  | { type: "chunk"; text: string }
  | { type: "final"; result: AgentResult }
  | { type: "error"; message: string };

// Sentence boundary: Devanagari danda, period, question, exclamation, comma, colon, semicolon
// followed by whitespace/end-of-string. Conservative — never splits mid-word.
const SENTENCE_BOUNDARY = /([।.?!,;:])\s/;

// Split `text` into [completedSentences, remainder]. The remainder is whatever
// came after the last boundary (no trailing punctuation yet).
export function splitSentences(text: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let buf = text;
  let m: RegExpMatchArray | null;
  // Iterate splitting at each boundary.
  while ((m = buf.match(SENTENCE_BOUNDARY)) !== null && m.index !== undefined) {
    const end = m.index + 1; // include the punctuation
    const sent = buf.slice(0, end).trim();
    if (sent) sentences.push(sent);
    buf = buf.slice(end + (m[0].length - 1)).trimStart();
  }
  return { sentences, remainder: buf };
}

// Incrementally extract the value of `agent_reply` from a streaming JSON
// object. Returns the cleartext (with JSON escapes resolved) accumulated so
// far and a flag indicating whether the closing quote has been seen.
//
// We parse character-by-character because Gemini's streaming response_format
// emits JSON tokens that can split mid-string. A naive JSON.parse on the
// partial buffer would throw on every chunk.
export class AgentReplyExtractor {
  private buffer = "";
  private inAgentReply = false;
  private closed = false;
  private extracted = "";
  private escapeNext = false;

  push(deltaText: string): { newText: string; closed: boolean } {
    this.buffer += deltaText;
    let newText = "";
    while (true) {
      if (!this.inAgentReply) {
        // Look for the literal `"agent_reply"` key followed by `:` and `"`.
        const keyIdx = this.buffer.indexOf('"agent_reply"');
        if (keyIdx === -1) return { newText, closed: false };
        // Find the opening quote of the value after the colon.
        let i = keyIdx + '"agent_reply"'.length;
        // Skip whitespace + colon + whitespace.
        while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
        if (i >= this.buffer.length) return { newText, closed: false };
        if (this.buffer[i] !== ":") {
          // Malformed; bail.
          this.buffer = this.buffer.slice(i);
          return { newText, closed: false };
        }
        i++;
        while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
        if (i >= this.buffer.length) return { newText, closed: false };
        if (this.buffer[i] !== '"') {
          // Not a string value; skip.
          this.buffer = this.buffer.slice(i);
          return { newText, closed: false };
        }
        // Move buffer past the opening quote.
        this.buffer = this.buffer.slice(i + 1);
        this.inAgentReply = true;
      }

      // Consume the buffer char-by-char until we hit an unescaped `"`.
      let i = 0;
      while (i < this.buffer.length) {
        const ch = this.buffer[i];
        if (this.escapeNext) {
          // Resolve simple JSON escapes; keep unicode escapes as-is for now.
          let resolved = ch;
          if (ch === "n") resolved = "\n";
          else if (ch === "t") resolved = "\t";
          else if (ch === "r") resolved = "\r";
          else if (ch === '"' || ch === "\\" || ch === "/") resolved = ch;
          newText += resolved;
          this.extracted += resolved;
          this.escapeNext = false;
          i++;
          continue;
        }
        if (ch === "\\") {
          this.escapeNext = true;
          i++;
          continue;
        }
        if (ch === '"') {
          // End of string.
          this.buffer = this.buffer.slice(i + 1);
          this.closed = true;
          return { newText, closed: true };
        }
        newText += ch;
        this.extracted += ch;
        i++;
      }
      // Consumed all of buffer without closing — wait for more data.
      this.buffer = "";
      return { newText, closed: false };
    }
  }

  // Total accumulated reply text so far.
  get text(): string {
    return this.extracted;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// Parse an SSE/streaming chunk line and return the delta text content if
// present. Lovable AI gateway proxies OpenAI-compatible SSE.
export function parseSseLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    return json.choices?.[0]?.delta?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * Helper Utility: Prepend the existing conversational memory profile block
 * into the master system instructions prompt payload config cleanly.
 */
export function injectMemoryToSystemPrompt(basePrompt: string, memoryContext: string | null): string {
  if (!memoryContext || !memoryContext.trim()) {
    return basePrompt;
  }
  return `CRITICAL HISTORICAL CONTEXT FOR THIS PATIENT (Use this to customize your greeting and follow-up style):
==================================================
${memoryContext.trim()}
==================================================

${basePrompt}`;
}