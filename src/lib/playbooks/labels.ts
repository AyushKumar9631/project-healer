// Friendly labels for playbook / use-case keys. Shared by the campaigns form,
// the calls list, and the call detail sheet so every surface stays in sync.

export const USE_CASE_LABELS: Record<string, string> = {
  screening_to_opd: "Screening → OPD",
  free_screening_invite: "Free Screening Invite",
  free_screening_invite_existing: "Free Screening Invite (Existing Patient)",
  newborn_vaccination: "Newborn Vaccination",
  inbound_reception: "Inbound Reception",
};

export function formatUseCase(key: string | null | undefined): string {
  if (!key) return "—";
  return USE_CASE_LABELS[key] ?? key;
}
