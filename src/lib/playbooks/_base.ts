// Playbook contract. Each healthcare use-case implements this interface.
// The greeting + turn endpoints resolve a playbook by `campaigns.use_case`
// and dispatch through it — they stay use-case agnostic.

import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type AdminClient = SupabaseClient<Database>;

export type GreetingSegments = { s1: string; s2: string; s3: string };

export type PlaybookKey =
  | "screening_to_opd"
  | "free_screening_invite"
  | "free_screening_invite_existing"
  | "newborn_vaccination"
  | "inbound_reception";

// Minimal patient/clinic shape every playbook can rely on.
export type PlaybookPatient = {
  id: string;
  name: string;
  phone?: string | null;
  age?: number | null;
  gender?: string | null;
  bp?: string | null;
  blood_sugar?: string | null;
  health_camp?: string | null;
  risk?: string | null;
};

export type PlaybookClinic = { id: string; name: string };

// A baby + the next due dose for vaccination playbook.
export type PlaybookBaby = {
  id: string;
  baby_name: string;
  parent_name: string;
  dob: string; // ISO date
  gender: string | null;
};

export type PlaybookDueDose = {
  id: string;
  age_milestone: string; // "6w" | "10w" | ...
  vaccine_code: string;
  due_date: string; // ISO date
};

// What the dispatcher hands to a playbook on every call.
export type PlaybookContext = {
  callId: string;
  clinic: PlaybookClinic;
  patient: PlaybookPatient;
  campaignId: string | null;
  playbookKey: PlaybookKey;
  // Per-campaign config_json (camp date / venue etc). May be empty {}.
  config: Record<string, unknown>;
  // Direction of THIS call. Defaults to "outbound" — only true outbound is
  // supported in production today, but the inbound branch is wired through
  // the prompts so the agent never produces "thanks for calling us"
  // phrasing on outbound calls (and is ready when inbound routing lands).
  direction: "outbound" | "inbound";
  // For newborn_vaccination only:
  baby?: PlaybookBaby | null;
  dueDoses?: PlaybookDueDose[];
};

// The structured fields every playbook returns. Specific playbooks extend
// this with their own keys (rsvp, baby_sentiment, etc.) but the dispatcher
// only relies on the base.
//
// The inbound_reception playbook extends this with additional intent values
// (general_enquiry, appointment_request, follow_up_request, complaint,
// callback_request, report_enquiry, emergency). InjectedReplySchema and
// AgentResult in api.public.agent.turn.ts are kept in sync with this union.
export type BaseAgentResult = {
  intent:
    | "interested"
    | "not_interested"
    | "busy"
    | "symptom"
    | "unclear"
    | "general_enquiry"
    | "appointment_request"
    | "follow_up_request"
    | "complaint"
    | "callback_request"
    | "report_enquiry"
    | "emergency";
  agent_reply: string;
  end_call: boolean;
  callback_requested: boolean;
  callback_time: string | null;
};

export interface Playbook<T extends BaseAgentResult = BaseAgentResult> {
  key: PlaybookKey;

  // Dynamic 3-segment greeting played before any LLM turn. s2/s3 may be "".
  buildGreeting(ctx: PlaybookContext): GreetingSegments;

  // System prompt fed to the LLM on each non-first turn.
  buildSystemPrompt(ctx: PlaybookContext): string;

  // Zod schema validating the LLM's JSON output for this playbook.
  outputSchema: z.ZodType<T>;

  // Persist playbook-specific outcome rows. Best-effort; errors logged.
  postProcess(args: {
    out: T;
    ctx: PlaybookContext;
    supabase: AdminClient;
    isEndOfCall: boolean;
  }): Promise<void>;
}
