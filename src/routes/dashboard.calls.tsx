import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PhoneCall } from "lucide-react";
import { SelectedCallDetail, type CallRow } from "@/components/CallDetailSheet";
import { CallLatencyCards } from "@/components/CallLatencyCards";
import { formatUseCase } from "@/lib/playbooks/labels";

export const Route = createFileRoute("/dashboard/calls")({ component: CallsPage });

function CallsPage() {
  const [selected, setSelected] = useState<CallRow | null>(null);

  const { data: calls = [] } = useQuery({
    queryKey: ["calls"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("calls")
        .select("*, patients(name,phone), doctors:suggested_doctor_id(name), campaigns(use_case), call_outcomes(playbook_key)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as unknown as CallRow[];
    },
  });

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Calls</h1>
        <p className="text-sm text-muted-foreground mt-1">Every call made by your AI agent</p>
      </div>

      <CallLatencyCards />

      {calls.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <PhoneCall className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium">No calls yet</h3>
          <p className="text-sm text-muted-foreground mt-1">Run a test call from a patient list to begin</p>
        </div>
      ) : (
        <div className="border rounded-xl bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs">
              <tr>
                <th className="text-left p-3">Patient</th>
                <th className="text-left p-3">Use case</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Intent</th>
                <th className="text-left p-3">Topic</th>
                <th className="text-left p-3">Doctor</th>
                <th className="text-left p-3">Appointment</th>
                <th className="text-left p-3">Callback</th>
                <th className="text-left p-3">When</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} onClick={() => setSelected(c)} className="border-t cursor-pointer hover:bg-accent/50">
                  <td className="p-3 font-medium">{c.patients?.name}</td>
                  <td className="p-3">
                    <Badge variant="outline" className="font-normal">
                      {formatUseCase(c.campaigns?.use_case ?? c.call_outcomes?.[0]?.playbook_key ?? null)}
                    </Badge>
                  </td>
                  <td className="p-3"><Badge variant="secondary">{c.status}</Badge></td>
                  <td className="p-3">{c.intent ?? "—"}</td>
                  <td className="p-3">{c.condition_mentioned ?? "—"}</td>
                  <td className="p-3">{c.doctors?.name ?? "—"}</td>
                  <td className="p-3">{c.appointment_time ? new Date(c.appointment_time).toLocaleString() : "—"}</td>
                  <td className="p-3">
                    {c.callback_time
                      ? new Date(c.callback_time).toLocaleString()
                      : c.callback_requested
                        ? "Yes"
                        : "—"}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">{new Date(c.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selected?.patients?.name}</SheetTitle>
          </SheetHeader>
          {selected && <SelectedCallDetail call={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
