import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Activity, PhoneCall, Stethoscope, TrendingUp, Upload, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Landing,
  head: () => ({
    meta: [
      { title: "CarePulse — AI voice agent for small clinics" },
      { name: "description", content: "Turn health camp screenings into OPD bookings with Hindi-speaking AI voice calls." },
      { property: "og:title", content: "CarePulse — AI voice agent for clinics" },
      { property: "og:description", content: "Hindi voice AI that converts screenings to OPD visits." },
    ],
  }),
});

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
              <Activity className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="font-semibold">CarePulse</span>
          </div>
          <nav className="flex items-center gap-2">
            <Link to="/login">
              <Button variant="ghost" size="sm">Sign in</Button>
            </Link>
            <Link to="/signup">
              <Button size="sm">Get started</Button>
            </Link>
          </nav>
        </div>
      </header>

      <section className="max-w-6xl mx-auto px-6 py-20 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent text-accent-foreground text-xs font-medium mb-6">
          <ShieldCheck className="h-3 w-3" /> Built for Indian clinics & health camps
        </div>
        <h1 className="text-5xl font-bold tracking-tight max-w-3xl mx-auto leading-tight">
          Turn health camp screenings into <span className="text-primary">OPD visits</span>
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
          A Hindi-speaking AI voice agent that calls your screened patients,
          understands their concerns, and books appointments with the right
          doctor — automatically.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link to="/signup">
            <Button size="lg">Start free</Button>
          </Link>
          <Link to="/login">
            <Button size="lg" variant="outline">Sign in</Button>
          </Link>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 pb-24 grid md:grid-cols-3 gap-6">
        {[
          { icon: Upload, t: "Upload your camp data", d: "Drag-drop a CSV of patients screened — name, phone, BP, sugar." },
          { icon: PhoneCall, t: "AI calls in Hindi", d: "Natural conversation, intent detection, appointment booking." },
          { icon: Stethoscope, t: "Routes to your doctors", d: "Knowledge base of your specialists matches conditions to doctors." },
        ].map((f, i) => (
          <div key={i} className="rounded-xl border bg-card p-6">
            <div className="h-10 w-10 rounded-lg bg-accent flex items-center justify-center mb-4">
              <f.icon className="h-5 w-5 text-primary" />
            </div>
            <h3 className="font-semibold">{f.t}</h3>
            <p className="text-sm text-muted-foreground mt-1">{f.d}</p>
          </div>
        ))}
      </section>

      <footer className="border-t">
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>© CarePulse</span>
          <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3" /> v1.0 · Simulator mode</span>
        </div>
      </footer>
    </div>
  );
}
