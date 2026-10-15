"use client";

import { useQuery } from "@tanstack/react-query";
import { staffQueryKeys } from "@campuscart/client";
import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react";
import { useAuth, useMe, useRuntime } from "./runtime";
import { Button, ErrorState, Field, Loading, SelectField } from "./ui";

export interface WorkOutlet {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  /** What this user may do there. The server checks every call regardless. */
  role: "manager" | "kitchen_staff" | "admin";
}

interface OutletState {
  outlets: WorkOutlet[];
  outlet: WorkOutlet;
  setOutletId: (id: string) => void;
}

const OutletContext = createContext<OutletState | null>(null);

export function useCurrentOutlet(): OutletState {
  const state = useContext(OutletContext);
  if (!state) throw new Error("useCurrentOutlet must be used inside StaffGate");
  return state;
}

function SignInForm({ appName }: { appName: string }) {
  const { supabase } = useRuntime();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    // Same message for unknown email and wrong password (no account enumeration).
    if (authError) setError("Email or password is incorrect.");
  }

  return (
    <main id="main" className="mx-auto grid min-h-screen max-w-sm content-center gap-6 px-4">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-primary">CampusCart</p>
        <h1 className="text-2xl font-bold tracking-tight">{appName}</h1>
        <p className="text-sm text-muted">Sign in with your staff account.</p>
      </div>
      <form className="grid gap-4" onSubmit={(e) => void submit(e)}>
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" busy={busy}>
          Sign in
        </Button>
      </form>
    </main>
  );
}

function NoAccess({ appName, message }: { appName: string; message: string }) {
  const { signOut } = useAuth();
  return (
    <main id="main" className="mx-auto grid min-h-screen max-w-md content-center gap-4 px-4">
      <h1 className="text-2xl font-bold">{appName}</h1>
      <p role="alert" className="rounded-xl bg-warn-soft px-4 py-3 text-warn">
        {message}
      </p>
      <Button variant="secondary" onClick={() => void signOut()}>
        Sign out
      </Button>
    </main>
  );
}

/**
 * Shows the sign-in form until a staff member is signed in, then provides the outlets they work
 * at. `need: "manager"` limits it to outlets they manage (admins: every outlet). This is only a
 * UX gate: the API and database enforce every permission.
 */
export function StaffGate({
  appName,
  need,
  children,
}: {
  appName: string;
  need: "manager" | "staff";
  children: ReactNode;
}) {
  const { session, ready } = useAuth();
  const { api } = useRuntime();
  const me = useMe();
  const isAdmin = me.data?.platform_roles.includes("admin") ?? false;
  // Managers' outlets (and every outlet for admins) come from the manager endpoint.
  const managed = useQuery({
    queryKey: staffQueryKeys.managedOutlets,
    queryFn: () => api.managedOutlets(),
    enabled: Boolean(session) && (need === "manager" || isAdmin),
  });
  const storageKey = `campuscart:${need}:outlet`;
  const [outletId, setOutletIdState] = useState<string | null>(() => {
    try {
      return typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
    } catch {
      return null; // Storage can be unavailable (private mode); the first outlet is used.
    }
  });

  if (!ready) return <Loading label="Loading" />;
  if (!session) return <SignInForm appName={appName} />;
  if (me.isPending) return <Loading label="Loading your account" />;
  if (me.isError)
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </main>
    );

  let outlets: WorkOutlet[];
  if (need === "manager" || isAdmin) {
    if (managed.isPending) return <Loading label="Loading your outlets" />;
    if (managed.isError)
      return (
        <main className="mx-auto max-w-md px-4 py-16">
          <ErrorState error={managed.error} onRetry={() => void managed.refetch()} />
        </main>
      );
    outlets = managed.data.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      timezone: o.timezone,
      role: isAdmin ? "admin" : "manager",
    }));
    if (need === "staff") {
      // Admin in the kitchen app: their own memberships plus every outlet.
      for (const m of me.data.outlet_roles) {
        if (!outlets.some((o) => o.id === m.outlet_id))
          outlets.push({
            id: m.outlet_id,
            name: m.outlet_name,
            slug: m.outlet_slug,
            timezone: m.outlet_timezone,
            role: m.role,
          });
      }
    }
  } else {
    outlets = me.data.outlet_roles.map((m) => ({
      id: m.outlet_id,
      name: m.outlet_name,
      slug: m.outlet_slug,
      timezone: m.outlet_timezone,
      role: m.role,
    }));
  }

  if (outlets.length === 0)
    return (
      <NoAccess
        appName={appName}
        message={
          need === "manager"
            ? "This account doesn't manage any outlet. Ask an administrator for access."
            : "This account isn't on any outlet's staff. Ask your outlet manager to add you."
        }
      />
    );

  const outlet = outlets.find((o) => o.id === outletId) ?? (outlets[0] as WorkOutlet);
  const setOutletId = (id: string) => {
    setOutletIdState(id);
    try {
      window.localStorage.setItem(storageKey, id);
    } catch {
      // Not persisted; the choice still applies for this visit.
    }
  };
  return (
    <OutletContext.Provider value={{ outlets, outlet, setOutletId }}>
      {children}
    </OutletContext.Provider>
  );
}

/** Switch between outlets the user works at (hidden when there is only one). */
export function OutletPicker() {
  const { outlets, outlet, setOutletId } = useCurrentOutlet();
  if (outlets.length < 2) return <p className="font-semibold">{outlet.name}</p>;
  return (
    <SelectField label="Outlet" value={outlet.id} onChange={(e) => setOutletId(e.target.value)}>
      {outlets.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </SelectField>
  );
}

export function SignOutButton() {
  const { signOut } = useAuth();
  const me = useMe();
  return (
    <div className="flex items-center gap-2 text-sm">
      {me.data && <span className="hidden text-muted sm:inline">{me.data.full_name}</span>}
      <Button variant="ghost" size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
