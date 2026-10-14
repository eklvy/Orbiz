"use client";

import { CAMPUS_TIME_ZONE, formatDayLabel, formatTime, type Schemas } from "@campuscart/client";

export function SlotPicker({
  slots,
  value,
  onChange,
  timeZone = CAMPUS_TIME_ZONE,
}: {
  slots: Schemas["PickupSlot"][];
  value: string | null;
  onChange: (slotId: string) => void;
  timeZone?: string | undefined;
}) {
  const groups = new Map<string, Schemas["PickupSlot"][]>();
  for (const slot of slots) {
    const day = formatDayLabel(slot.starts_at, timeZone);
    groups.set(day, [...(groups.get(day) ?? []), slot]);
  }
  return (
    <fieldset className="grid gap-4">
      <legend className="mb-2 font-semibold">Pickup time</legend>
      {[...groups].map(([day, daySlots]) => (
        <div key={day}>
          <p className="mb-2 text-sm font-medium text-muted">{day}</p>
          <div className="flex flex-wrap gap-2">
            {daySlots.map((slot) => {
              const selected = value === slot.id;
              return (
                <label
                  key={slot.id}
                  className={`flex cursor-pointer flex-col rounded-lg border px-3 py-2 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-45 has-focus-visible:outline-2 has-focus-visible:outline-primary ${
                    selected
                      ? "border-primary bg-primary-soft"
                      : "border-line bg-surface hover:border-primary/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="pickup-slot"
                    value={slot.id}
                    checked={selected}
                    disabled={!slot.bookable}
                    onChange={() => onChange(slot.id)}
                    className="sr-only"
                  />
                  <span className="font-semibold">{formatTime(slot.starts_at, timeZone)}</span>
                  <span className="text-xs text-muted">
                    {slot.bookable ? `${slot.remaining} left` : "Full"}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
