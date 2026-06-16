// Generic LLM runner for non-screening playbooks.
// Screening keeps its own bespoke runner in api.public.agent.turn.ts because
// it has fast-paths (consent / callback) and KB injection that the other
// playbooks don't need yet.

import type { Playbook, PlaybookContext, BaseAgentResult } from "./_base";

// "system" role is used for server-injected validation messages (e.g. slot
// conflict or past-time feedback) that the LLM must read before responding.
// These lines are rendered as "System: ..." in the conversation transcript so
// the model treats them as authoritative, not as patient speech.
type Turn = { role: "agent" | "patient" | "system"; text: string };

export async function runPlaybookTurn<T extends BaseAgentResult>(args: {
  playbook: Playbook<T>;
  ctx: PlaybookContext;
  utterance: string;
  isFirstTurn: boolean;
  history: Turn[];
}): Promise<T> {
  const { playbook, ctx, utterance, isFirstTurn, history } = args;
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

  const system = playbook.buildSystemPrompt(ctx);
  const transcript = history
    .map((t) => {
      if (t.role === "agent") return `Agent: ${t.text}`;
      if (t.role === "system") return `System: ${t.text}`;
      return `Patient: ${t.text}`;
    })
    .join("\n");

  const userMsg = isFirstTurn
    ? `This is the OPENING of the call. Greet the patient warmly and ask about their wellbeing as instructed. Return JSON only.`
    : utterance.trim()
      ? `Conversation so far:\n${transcript}\n\nPatient just said: "${utterance}"\n\nProduce the next agent turn as JSON.`
      : `Conversation so far:\n${transcript}\n\nA System message has just been appended above. Read it and produce the next agent turn as JSON.`;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.AGENT_TURN_MODEL ?? "google/gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
      // 2000 tokens: the confirmation turn must output 13 JSON fields in one
      // response (ISO timestamp, doctor UUID, Hindi reply, end_call=true, …).
      // 800 was enough for simple mid-call turns but caused silent truncation
      // on the densest turn (appointment confirmation): JSON.parse threw →
      // Zod .catch() fired → agent_reply fell back to the greeting phrase →
      // infinite re-greeting loop every subsequent turn.
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI gateway error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content ?? "{}";

  // Truncation guard: a complete JSON object always ends with `}`.
  // If it doesn't, the model was cut off mid-stream and parse will silently
  // return {}, triggering the Zod fallback loop. Log loudly so it's visible.
  const trimmedContent = content.trim();
  if (trimmedContent && !trimmedContent.endsWith("}")) {
    console.error(
      `[_runner] playbook=${playbook.key} TRUNCATED JSON — response did not close with "}". ` +
        `Tail: "${trimmedContent.slice(-120)}". Raise max_tokens or shorten the prompt.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    console.error(
      `[_runner] playbook=${playbook.key} JSON.parse failed. Tail: "${content.slice(-200)}"`,
    );
    raw = {};
  }
  return playbook.outputSchema.parse(raw);
}
