// Playbook registry. Resolve by `campaigns.use_case` (or fallback default).

import type { Playbook, PlaybookKey } from "./_base";
import { screeningToOpdPlaybook } from "./screeningToOpd";
import { freeScreeningInvitePlaybook } from "./freeScreeningInvite";
import { freeScreeningInviteExistingPlaybook } from "./freeScreeningInviteExisting";
import { newbornVaccinationPlaybook } from "./newbornVaccination";
import { inboundReceptionPlaybook } from "./inboundReception";

// Use a loose Playbook<any-result-shape> for the registry — the dispatcher
// validates each playbook's output against its own schema at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY: Record<PlaybookKey, Playbook<any>> = {
  screening_to_opd: screeningToOpdPlaybook,
  free_screening_invite: freeScreeningInvitePlaybook,
  free_screening_invite_existing: freeScreeningInviteExistingPlaybook,
  newborn_vaccination: newbornVaccinationPlaybook,
  inbound_reception: inboundReceptionPlaybook,
};

const VALID_KEYS = new Set<PlaybookKey>(Object.keys(REGISTRY) as PlaybookKey[]);

export function resolvePlaybook(useCase: string | null | undefined): Playbook {
  const key = (useCase ?? "screening_to_opd") as PlaybookKey;
  if (VALID_KEYS.has(key)) return REGISTRY[key];
  return REGISTRY.screening_to_opd;
}

export function isValidPlaybookKey(key: string): key is PlaybookKey {
  return VALID_KEYS.has(key as PlaybookKey);
}

export const PLAYBOOK_KEYS: PlaybookKey[] = Array.from(VALID_KEYS);

export type { Playbook, PlaybookKey } from "./_base";
