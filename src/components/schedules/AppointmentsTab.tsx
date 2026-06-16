import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { CalendarDays, Clock, User, Stethoscope, Phone, FileText, Calendar } from "lucide-react";

interface AppointmentRow {
  id: string;
  call_id: string;
  clinic_id: string;
  patient_id: string;
  doctor_id: string;
  appointment_date: string;       // "YYYY-MM-DD"
  appointment_time: string;       // "HH:MM:SS+05:30" (timetz)
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // joined
  patients: { name: string; phone: string | null } | null;
  doctors: { name: string; specialization: string | null } | null;
  calls: { condition_mentioned: string | null } | null;
}

function formatAppointmentTime(date: string, time: string): { date: string; time: string; full: Date } {
  // date: "2026-06-04", time: "11:30:00+05:30"
  const combined = new Date(`${date}T${time}`);
  const fmtDate = combined.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const fmtTime = combined.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  return { date: fmtDate, time: fmtTime, full: combined };
}

function isUpcoming(date: string, time: string): boolean {
  try {
    const dt = new Date(`${date}T${time}`);
    return dt.getTime() > Date.now();
  } catch {
    return false;
  }
}

function statusColor(status: string) {
  switch (status) {
    case "scheduled": return "bg-blue-500/10 text-blue-600 border-blue-200";
    case "confirmed": return "bg-emerald-500/10 text-emerald-600 border-emerald-200";
    case "completed": return "bg-muted text-muted-foreground border-border";
    case "cancelled": return "bg-red-500/10 text-red-600 border-red-200";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

export function AppointmentsTab() {
  const [doctorFilter, setDoctorFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<string>("all");

  const { data: appointments = [], isLoading } = useQuery({
    queryKey: ["appointments_upcoming"],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from("appointments")
        .select(
          "id, call_id, clinic_id, patient_id, doctor_id, appointment_date, appointment_time, status, notes, created_at, updated_at, patients(name, phone), doctors(name, specialization), calls(condition_mentioned)"
        )
        .gte("appointment_date", today)
        .order("appointment_date", { ascending: true })
        .order("appointment_time", { ascending: true })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as AppointmentRow[];
    },
  });

  // Filter to upcoming only (in case timetz comparison needs double-check)
  const upcoming = useMemo(
    () => appointments.filter((a) => isUpcoming(a.appointment_date, a.appointment_time)),
    [appointments]
  );

  // Unique doctors from the result set
  const doctorOptions = useMemo(() => {
    const map = new Map<string, string>();
    upcoming.forEach((a) => {
      if (a.doctor_id && a.doctors?.name) map.set(a.doctor_id, a.doctors.name);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [upcoming]);

  // Date range options
  const dateOptions = [
    { value: "all", label: "All upcoming" },
    { value: "today", label: "Today" },
    { value: "tomorrow", label: "Tomorrow" },
    { value: "week", label: "This week" },
    { value: "month", label: "This month" },
  ];

  const filtered = useMemo(() => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + 7);
    const monthEnd = new Date(now); monthEnd.setMonth(now.getMonth() + 1);

    return upcoming.filter((a) => {
      if (doctorFilter !== "all" && a.doctor_id !== doctorFilter) return false;
      if (dateFilter !== "all") {
        const apptDate = new Date(a.appointment_date + "T00:00:00");
        if (dateFilter === "today" && a.appointment_date !== todayStr) return false;
        if (dateFilter === "tomorrow" && a.appointment_date !== tomorrowStr) return false;
        if (dateFilter === "week" && (apptDate < now || apptDate > weekEnd)) return false;
        if (dateFilter === "month" && (apptDate < now || apptDate > monthEnd)) return false;
      }
      return true;
    });
  }, [upcoming, doctorFilter, dateFilter]);

  // Group by date
  const grouped = useMemo(() => {
    const groups = new Map<string, AppointmentRow[]>();
    filtered.forEach((a) => {
      const existing = groups.get(a.appointment_date) ?? [];
      groups.set(a.appointment_date, [...existing, a]);
    });
    return groups;
  }, [filtered]);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Doctor</Label>
          <Select value={doctorFilter} onValueChange={setDoctorFilter}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="All doctors" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All doctors</SelectItem>
              {doctorOptions.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Date range</Label>
          <Select value={dateFilter} onValueChange={setDateFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dateOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="ml-auto text-xs text-muted-foreground self-end pb-2">
          {filtered.length} {filtered.length === 1 ? "appointment" : "appointments"}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="rounded-xl border bg-card p-12 text-center text-sm text-muted-foreground">
          Loading appointments…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <CalendarDays className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-medium">No upcoming appointments</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Appointments booked via inbound calls will appear here
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {Array.from(grouped.entries()).map(([date, appts]) => {
            const dateLabel = new Date(date + "T00:00:00").toLocaleDateString("en-IN", {
              weekday: "long", day: "numeric", month: "long", year: "numeric"
            });
            const isToday = date === new Date().toISOString().slice(0, 10);

            return (
              <div key={date} className="space-y-3">
                {/* Date group header */}
                <div className="flex items-center gap-3">
                  <div className={`flex items-center gap-2 text-sm font-semibold ${isToday ? "text-primary" : "text-foreground"}`}>
                    <Calendar className="h-4 w-4" />
                    {dateLabel}
                    {isToday && (
                      <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 py-0 h-4">Today</Badge>
                    )}
                  </div>
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-muted-foreground">{appts.length} appt{appts.length !== 1 ? "s" : ""}</span>
                </div>

                {/* Appointment cards */}
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {appts.map((appt) => {
                    const { time } = formatAppointmentTime(appt.appointment_date, appt.appointment_time);
                    const reason = appt.calls?.condition_mentioned || appt.notes;

                    return (
                      <div
                        key={appt.id}
                        className="rounded-xl border bg-card p-4 space-y-3 hover:border-primary/30 hover:shadow-sm transition-all"
                      >
                        {/* Header row: time + status */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-sm font-semibold text-primary">
                            <Clock className="h-3.5 w-3.5" />
                            {time}
                          </div>
                          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border capitalize ${statusColor(appt.status)}`}>
                            {appt.status}
                          </span>
                        </div>

                        {/* Patient */}
                        <div className="flex items-start gap-2">
                          <div className="mt-0.5 h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                            <User className="h-3.5 w-3.5 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium text-sm truncate">
                              {appt.patients?.name ?? "Unknown Patient"}
                            </div>
                            {appt.patients?.phone && (
                              <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                                <Phone className="h-3 w-3" />
                                {appt.patients.phone}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Doctor */}
                        <div className="flex items-start gap-2">
                          <div className="mt-0.5 h-7 w-7 rounded-full bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                            <Stethoscope className="h-3.5 w-3.5 text-emerald-600" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium text-sm truncate">
                              {appt.doctors?.name ?? "Doctor not assigned"}
                            </div>
                            {appt.doctors?.specialization && (
                              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                                {appt.doctors.specialization}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Reason / notes */}
                        {reason && (
                          <div className="flex items-start gap-2 pt-1 border-t border-dashed border-border">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                              {reason}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
