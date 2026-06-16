import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Plus, Pencil, Trash2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

interface Policy {
  id: string;
  title: string;
  rule: string;
  priority: number;
  is_active: boolean;
}

export function PoliciesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Policy | null>(null);

  const { data: policies = [] } = useQuery({
    queryKey: ["kb-policies"],
    queryFn: async () => {
      const { data, error } = await supabase.from("kb_policies").select("*").order("priority", { ascending: true });
      if (error) throw error;
      return data as Policy[];
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("kb_policies").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["kb-policies"] }); toast.success("Policy removed"); },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Hard rules the AI agent must always follow on calls. Lower priority numbers appear first in the prompt.
        </p>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4 mr-1.5" /> Add policy</Button>
          </DialogTrigger>
          <PolicyDialog editing={editing} onClose={() => setOpen(false)} />
        </Dialog>
      </div>

      {policies.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <ShieldCheck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium">No policies yet</h3>
          <p className="text-sm text-muted-foreground mt-1">Examples: "Never quote final surgery cost on call", "Always offer free consult to camp patients".</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card divide-y">
          {policies.map((p) => (
            <div key={p.id} className="p-4 flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs">#{p.priority}</Badge>
                  <h4 className="font-medium">{p.title}</h4>
                  {!p.is_active && <Badge variant="outline" className="text-xs">inactive</Badge>}
                </div>
                <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{p.rule}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button variant="ghost" size="icon" onClick={() => { setEditing(p); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" onClick={() => del.mutate(p.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PolicyDialog({ editing, onClose }: { editing: Policy | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    title: editing?.title ?? "",
    rule: editing?.rule ?? "",
    priority: editing?.priority ?? 100,
    is_active: editing?.is_active ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const { data: clinicRow } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinicRow) throw new Error("No clinic");
      const payload = {
        clinic_id: clinicRow.id,
        title: form.title,
        rule: form.rule,
        priority: Number(form.priority) || 100,
        is_active: form.is_active,
      };
      if (editing) {
        const { error } = await supabase.from("kb_policies").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("kb_policies").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["kb-policies"] }); toast.success(editing ? "Policy updated" : "Policy added"); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle>{editing ? "Edit policy" : "Add policy"}</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>Title</Label>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Surgery pricing" />
        </div>
        <div>
          <Label>Rule the AI must follow</Label>
          <Textarea rows={4} value={form.rule} onChange={(e) => setForm({ ...form, rule: e.target.value })} placeholder="Never quote final surgery cost on call. Always say final cost is shared after surgeon consultation." />
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <div>
            <Label>Priority (lower = first)</Label>
            <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
          </div>
          <div className="flex items-center gap-3 pb-2">
            <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
            <Label className="cursor-pointer">Active</Label>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={!form.title || !form.rule || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
