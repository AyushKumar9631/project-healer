import { Badge } from "@/components/ui/badge";
import { formatUseCase } from "@/lib/playbooks/labels";
import {
  OUTCOME_SCHEMAS,
  formatCellText,
  getStructured,
  type OutcomeColumn,
} from "@/lib/playbooks/outcomeSchemas";
import type { PlaybookKey } from "@/lib/playbooks/_base";

export type OutcomeRow = {
  call_id: string;
  playbook_key: string;
  structured: Record<string, unknown> | null;
  success: boolean;
  red_flag: boolean;
  created_at: string;
  calls: {
    id: string;
    status: string;
    created_at: string;
    duration_seconds: number | null;
    transcript: { role: string; text: string; dropped_reason?: string; ts?: string }[] | null;
    notes: string | null;
    patients: { name: string; phone: string } | null;
  } | null;
};

export function OutcomeDetail({ row }: { row: OutcomeRow }) {
  const cols: OutcomeColumn[] =
    OUTCOME_SCHEMAS[row.playbook_key as PlaybookKey] ?? [];
  const structured = (row.structured ?? {}) as Record<string, unknown>;

  return (
    <div className="mt-6 space-y-5">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Field label="Use case" value={formatUseCase(row.playbook_key)} />
        <Field label="Patient" value={row.calls?.patients?.name ?? "—"} />
        <Field
          label="Success"
          value={row.success ? "Yes" : "No"}
          tone={row.success ? "success" : undefined}
        />
        <Field
          label="Red flag"
          value={row.red_flag ? "Yes" : "No"}
          tone={row.red_flag ? "danger" : undefined}
        />
        <Field label="Status" value={row.calls?.status ?? "—"} />
        <Field
          label="Duration"
          value={row.calls?.duration_seconds ? `${row.calls.duration_seconds}s` : "—"}
        />
        <Field
          label="Callback"
          value={
            structured.callback_time
              ? new Date(String(structured.callback_time)).toLocaleString()
              : structured.callback_requested
                ? "Yes — no time given"
                : "—"
          }
        />
        <Field label="When" value={new Date(row.created_at).toLocaleString()} />
      </div>

      {cols.length > 0 && (
        <div>
          <div className="text-xs text-muted-foreground mb-2">Outcome details</div>
          <div className="grid grid-cols-2 gap-3 text-sm bg-muted/40 p-3 rounded-md">
            {cols.map((c) => {
              const raw = getStructured(structured, c.key);
              if (c.format === "list") {
                const items = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
                return <ChipsField key={c.key} label={c.label} items={items} />;
              }
              return <Field key={c.key} label={c.label} value={formatCellText(raw, c.format)} />;
            })}
          </div>
        </div>
      )}

      {row.calls?.notes && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Notes</div>
          <div className="text-sm bg-muted p-3 rounded-md">{row.calls.notes}</div>
        </div>
      )}

      {row.calls?.transcript?.length ? (
        <div>
          <div className="text-xs text-muted-foreground mb-2">Transcript</div>
          <div className="space-y-2">
            {row.calls.transcript.map((t, i) => {
              const dropped = t.role === "patient" && !!t.dropped_reason;
              const droppedLabel =
                t.dropped_reason === "turn_in_flight"
                  ? "Heard while agent was replying"
                  : t.dropped_reason === "post_playout_guard"
                    ? "Heard while agent was finishing"
                    : null;
              return (
                <div
                  key={i}
                  className={`text-sm p-2 rounded-md ${
                    t.role === "agent"
                      ? "bg-accent"
                      : dropped
                        ? "bg-muted/40 border border-dashed border-muted-foreground/30 text-muted-foreground"
                        : "bg-muted"
                  }`}
                >
                  <div className="text-xs font-medium text-muted-foreground mb-0.5 flex items-center gap-2">
                    <span>{t.role === "agent" ? "AI Agent" : "Patient"}</span>
                    {droppedLabel && (
                      <Badge variant="outline" className="font-normal text-[10px] py-0 h-4">
                        {droppedLabel}
                      </Badge>
                    )}
                  </div>
                  {t.text}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null | undefined;
  tone?: "success" | "danger";
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          tone === "success"
            ? "font-medium text-emerald-600"
            : tone === "danger"
              ? "font-medium text-destructive"
              : "font-medium"
        }
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function ChipsField({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {items.length === 0 ? (
        <div className="font-medium">—</div>
      ) : (
        <div className="flex flex-wrap gap-1 mt-1">
          {items.map((it) => (
            <Badge key={it} variant="secondary" className="font-normal">
              {it}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
