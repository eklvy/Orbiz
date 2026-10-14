"use client";

export function QuantityStepper({
  value,
  onChange,
  max = 20,
  label,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  max?: number;
  label: string;
  disabled?: boolean;
}) {
  const button =
    "grid size-9 place-items-center rounded-md text-lg font-semibold hover:bg-surface-2 disabled:opacity-40";
  return (
    <div
      className="inline-flex items-center rounded-lg border border-line bg-surface"
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className={button}
        onClick={() => onChange(value - 1)}
        disabled={disabled}
        aria-label={`Remove one ${label}`}
      >
        −
      </button>
      <span className="w-8 text-center font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className={button}
        onClick={() => onChange(value + 1)}
        disabled={disabled || value >= max}
        aria-label={`Add one ${label}`}
      >
        +
      </button>
    </div>
  );
}
