import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/dashboard/doctors")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/knowledge", search: { tab: "doctors" } });
  },
  component: () => null,
});
