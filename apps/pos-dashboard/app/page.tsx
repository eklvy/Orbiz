"use client";

import {
  DealsPanel,
  KitchenBoard,
  OutletPicker,
  SignOutButton,
  StaffGate,
  useCurrentOutlet,
} from "@campuscart/staff-web";

function Counter() {
  const { outlet } = useCurrentOutlet();
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-end justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-end gap-4">
            <p className="text-lg font-bold tracking-tight">CampusCart Kitchen</p>
            <div className="min-w-48">
              <OutletPicker />
            </div>
          </div>
          <SignOutButton />
        </div>
      </header>
      <main id="main" className="mx-auto grid max-w-screen-2xl gap-8 px-4 py-6">
        <h1 className="sr-only">Orders at {outlet.name}</h1>
        <KitchenBoard key={outlet.id} outletId={outlet.id} timeZone={outlet.timezone} />
        <section aria-labelledby="deals-heading" className="grid gap-3">
          <div>
            <h2 id="deals-heading" className="text-lg font-semibold">
              Uncollected orders &amp; deals
            </h2>
            <p className="text-sm text-muted">
              Not collected by the deadline: no refund, packaged items go back into stock, and the
              prepared food goes on sale to other students. A bought deal appears above as a new
              ready order.
            </p>
          </div>
          <DealsPanel key={outlet.id} outletId={outlet.id} timeZone={outlet.timezone} />
        </section>
      </main>
    </>
  );
}

export default function KitchenPage() {
  return (
    <StaffGate appName="CampusCart Kitchen" need="staff">
      <Counter />
    </StaffGate>
  );
}
