export function ReviewWatermarkOverlay({ label }: { label: string | null | undefined }) {
  if (!label) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[15] overflow-hidden select-none"
    >
      <div className="absolute -inset-1/2 flex flex-wrap content-center justify-center gap-x-20 gap-y-16 rotate-[-28deg] opacity-[0.16]">
        {Array.from({ length: 40 }, (_, index) => (
          <span
            key={index}
            className="whitespace-nowrap text-xs font-medium tracking-wide text-white drop-shadow"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
