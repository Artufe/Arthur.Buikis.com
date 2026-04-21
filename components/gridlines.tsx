export function Gridlines() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 hidden lg:block">
      {[16.67, 33.33, 66.67, 83.33].map((pct) => (
        <div
          key={pct}
          className="absolute top-0 bottom-0 w-px bg-[var(--fg)]/[0.08]"
          style={{ left: `${pct}%` }}
        />
      ))}
    </div>
  );
}
