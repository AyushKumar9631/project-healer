import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ClipboardList } from "lucide-react";
import { formatUseCase } from "@/lib/playbooks/labels";
import { PLAYBOOK_KEYS, type PlaybookKey } from "@/lib/playbooks/registry";
import {
  OUTCOME_SCHEMAS,
  formatCellText,
  getStructured,
} from "@/lib/playbooks/outcomeSchemas";
import { OutcomeDetail, type OutcomeRow } from "@/components/OutcomeDetailSheet";

export const Route = createFileRoute("/dashboard/outcomes")({ component: OutcomesPage });

type Filter = PlaybookKey | "all";

function OutcomesPage() {
  const [useCase, setUseCase] = useState<Filter>("all");
  const [resultFilter, setResultFilter] = useState<"all" | "success" | "not_success">("all");
  const [redOnly, setRedOnly] = useState(false);
  const [selected, setSelected] = useState<OutcomeRow | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["call_outcomes", useCase],
    queryFn: async () => {
      let q = supabase
        .from("call_outcomes")
        .select(
          "call_id, playbook_key, structured, success, red_flag, created_at, calls(id, status, created_at, duration_seconds, transcript, notes, patients(name, phone))",
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (useCase !== "all") q = q.eq("playbook_key", useCase);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as OutcomeRow[];
    },
  });

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (redOnly && !r.red_flag) return false;
        if (resultFilter === "success" && !r.success) return false;
        if (resultFilter === "not_success" && r.success) return false;
        return true;
      }),
    [rows, redOnly, resultFilter],
  );

  const cols =
    useCase === "all" ? [] : OUTCOME_SCHEMAS[useCase as PlaybookKey] ?? [];

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Outcomes</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Structured results captured from each call, grouped by use case
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Use case</Label>
          <Select value={useCase} onValueChange={(v) => setUseCase(v as Filter)}>
            <SelectTrigger className="w-[280px]">
              <SelectValue placeholder="Select use case" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All use cases</SelectItem>
              {PLAYBOOK_KEYS.map((k) => (
                <SelectItem key={k} value={k}>
                  {formatUseCase(k)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Result</Label>
          <Select value={resultFilter} onValueChange={(v) => setResultFilter(v as typeof resultFilter)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All results</SelectItem>
              <SelectItem value="success">Success only</SelectItem>
              <SelectItem value="not_success">Not successful</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 h-10">
          <Checkbox
            id="redOnly"
            checked={redOnly}
            onCheckedChange={(v) => setRedOnly(v === true)}
          />
          <Label htmlFor="redOnly" className="text-sm cursor-pointer">
            Red flag only
          </Label>
        </div>

        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "outcome" : "outcomes"}
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card p-12 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <ClipboardList className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium">No outcomes yet</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Completed calls appear here within a few seconds of hangup
          </p>
        </div>
      ) : (
        <div className="border rounded-xl bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs">
              <tr>
                <th className="text-left p-3">Patient</th>
                {useCase === "all" && <th className="text-left p-3">Use case</th>}
                {cols.map((c) => (
                  <th key={c.key} className="text-left p-3">{c.label}</th>
                ))}
                <th className="text-left p-3">Success</th>
                <th className="text-left p-3">Red flag</th>
                <th className="text-left p-3">When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.call_id}
                  onClick={() => setSelected(r)}
                  className="border-t cursor-pointer hover:bg-accent/50"
                >
                  <td className="p-3 font-medium">{r.calls?.patients?.name ?? "—"}</td>
                  {useCase === "all" && (
                    <td className="p-3">
                      <Badge variant="outline" className="font-normal">
                        {formatUseCase(r.playbook_key)}
                      </Badge>
                    </td>
                  )}
                  {cols.map((c) => {
                    const raw = getStructured(r.structured, c.key);
                    if (c.format === "badge") {
                      const text = formatCellText(raw, c.format);
                      return (
                        <td key={c.key} className="p-3">
                          {text === "—" ? "—" : <Badge variant="secondary">{text}</Badge>}
                        </td>
                      );
                    }
                    if (c.format === "list") {
                      const items = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
                      return (
                        <td key={c.key} className="p-3">
                          {items.length === 0 ? "—" : (
                            <div className="flex flex-wrap gap-1">
                              {items.slice(0, 3).map((it) => (
                                <Badge key={it} variant="secondary" className="font-normal">{it}</Badge>
                              ))}
                              {items.length > 3 && (
                                <span className="text-xs text-muted-foreground">+{items.length - 3}</span>
                              )}
                            </div>
                          )}
                        </td>
                      );
                    }
                    return (
                      <td key={c.key} className="p-3">{formatCellText(raw, c.format)}</td>
                    );
                  })}
                  <td className="p-3">
                    {r.success ? (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600">Yes</Badge>
                    ) : (
                      <span className="text-muted-foreground">No</span>
                    )}
                  </td>
                  <td className="p-3">
                    {r.red_flag ? (
                      <Badge variant="destructive">Red flag</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selected?.calls?.patients?.name ?? "Outcome"}</SheetTitle>
          </SheetHeader>
          {selected && <OutcomeDetail row={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
