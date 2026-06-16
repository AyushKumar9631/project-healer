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
import { Plus, Pencil, Trash2, HelpCircle } from "lucide-react";
import { toast } from "sonner";

interface Faq {
  id: string;
  question: string;
  answer: string;
  tags: string[];
  is_active: boolean;
}

export function FaqsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Faq | null>(null);
  const [search, setSearch] = useState("");

  const { data: faqs = [] } = useQuery({
    queryKey: ["kb-faqs"],
    queryFn: async () => {
      const { data, error } = await supabase.from("kb_faqs").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data as Faq[];
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("kb_faqs").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["kb-faqs"] }); toast.success("FAQ removed"); },
  });

  const filtered = faqs.filter((f) => {
    const q = search.toLowerCase();
    return !q || f.question.toLowerCase().includes(q) || f.answer.toLowerCase().includes(q) || f.tags.some((t) => t.toLowerCase().includes(q));
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Input placeholder="Search FAQs…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-md" />
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4 mr-1.5" /> Add FAQ</Button>
          </DialogTrigger>
          <FaqDialog editing={editing} onClose={() => setOpen(false)} />
        </Dialog>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <HelpCircle className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium">No FAQs yet</h3>
          <p className="text-sm text-muted-foreground mt-1">Add common questions & answers (insurance, ambulance, reports…) for the AI to use.</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card divide-y">
          {filtered.map((f) => (
            <div key={f.id} className="p-4 flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-medium">{f.question}</h4>
                  {!f.is_active && <Badge variant="outline" className="text-xs">inactive</Badge>}
                </div>
                <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{f.answer}</p>
                {f.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {f.tags.map((t) => <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>)}
                  </div>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <Button variant="ghost" size="icon" onClick={() => { setEditing(f); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" onClick={() => del.mutate(f.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FaqDialog({ editing, onClose }: { editing: Faq | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    question: editing?.question ?? "",
    answer: editing?.answer ?? "",
    tags: editing?.tags.join(", ") ?? "",
    is_active: editing?.is_active ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const { data: clinicRow } = await supabase.from("clinics").select("id").maybeSingle();
      if (!clinicRow) throw new Error("No clinic");
      const payload = {
        clinic_id: clinicRow.id,
        question: form.question,
        answer: form.answer,
        tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean),
        is_active: form.is_active,
      };
      if (editing) {
        const { error } = await supabase.from("kb_faqs").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("kb_faqs").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["kb-faqs"] }); toast.success(editing ? "FAQ updated" : "FAQ added"); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{editing ? "Edit FAQ" : "Add FAQ"}</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>Question</Label>
          <Input value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="Do you accept Star Health insurance?" />
        </div>
        <div>
          <Label>Answer</Label>
          <Textarea rows={5} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} placeholder="Yes, we are empanelled with..." />
        </div>
        <div>
          <Label>Tags (comma-separated)</Label>
          <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="insurance, cashless" />
        </div>
        <div className="flex items-center gap-3">
          <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
          <Label className="cursor-pointer">Active (used by AI)</Label>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={!form.question || !form.answer || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
