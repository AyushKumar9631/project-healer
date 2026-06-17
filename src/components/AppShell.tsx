import { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Activity, LayoutDashboard, Users, BookOpen, Megaphone, LogOut, PhoneCall, ClipboardList, CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/dashboard/knowledge", label: "Knowledge Base", icon: BookOpen },
  { to: "/dashboard/patients", label: "Patient Lists", icon: Users },
  { to: "/dashboard/campaigns", label: "Campaigns", icon: Megaphone },
  { to: "/dashboard/calls", label: "Calls", icon: PhoneCall },
  { to: "/dashboard/outcomes", label: "Outcomes", icon: ClipboardList },
  { to: "/dashboard/schedules", label: "Schedules", icon: CalendarDays },
];

export function AppShell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const nav2 = useNavigate();
  const { signOut, user } = useAuth();

  return (
    <div className="min-h-screen flex bg-background">
      <aside className="w-64 border-r bg-sidebar flex flex-col">
        <div className="px-6 py-5 border-b flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
            <Activity className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <div className="font-semibold text-sm">CarePulse</div>
            <div className="text-xs text-muted-foreground">Voice AI(v5)</div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map((n) => {
            const active = loc.pathname === n.to || (n.to !== "/dashboard" && loc.pathname.startsWith(n.to));
            const Icon = n.icon;
            return (
              <Link
                key={n.to}
                to={n.to}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-accent"
                )}
              >
                <Icon className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t">
          <div className="px-3 py-2 text-xs text-muted-foreground truncate">{user?.email}</div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={async () => {
              await signOut();
              nav2({ to: "/login" });
            }}
          >
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
