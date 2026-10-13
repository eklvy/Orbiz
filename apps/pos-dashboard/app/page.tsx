import { API_VERSION_PREFIX } from "@campuscart/contracts";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4 py-16">
      <p className="text-sm font-medium uppercase tracking-wide text-[var(--muted)]">CampusCart</p>
      <h1 className="text-3xl font-semibold">CampusCart Kitchen</h1>
      <p className="text-[var(--muted)]">
        Live order queue, preparation status and pickup verification for counter staff.
      </p>
      <p className="rounded-md border border-current/15 px-3 py-2 text-sm">
        Scaffolding only. This interface is implemented in Phase 4. It will talk to the API at{" "}
        <code>{API_VERSION_PREFIX}</code>.
      </p>
    </main>
  );
}
