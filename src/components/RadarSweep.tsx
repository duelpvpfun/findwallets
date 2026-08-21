"use client";

/**
 * The scanning metaphor, made visible: a conic gradient rotating behind
 * concentric rings.
 *
 * Deliberately restrained. This sits behind a tool people keep open for hours,
 * so it is one rotating element plus three scaling rings — `transform` and
 * `opacity` only, nothing that can trigger layout — at low enough opacity to
 * read as depth rather than decoration. Everything stops under
 * `prefers-reduced-motion` (see globals.css); the rings resolve to a static
 * outline so the shape still reads.
 *
 * Used in exactly two places, both where it earns its keep: while a scan is
 * running, and on the empty state before one has been run.
 */
export default function RadarSweep({
  size = 220,
  className = "",
  tone = "blue",
}: {
  size?: number;
  className?: string;
  tone?: "blue" | "emerald";
}) {
  const accent = tone === "emerald" ? "16 185 129" : "59 130 246";

  return (
    <div
      aria-hidden
      className={`pointer-events-none relative ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Rings. Staggered so they read as a pulse travelling outward. */}
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="radar-ping absolute inset-0 rounded-full border"
          style={{
            borderColor: `rgb(${accent} / 0.35)`,
            animationDelay: `${i * 1.05}s`,
          }}
        />
      ))}

      {/* Static grid: a fixed reference the sweep passes over, which is what
          makes the rotation legible at this opacity. */}
      <span
        className="absolute inset-0 rounded-full border"
        style={{ borderColor: `rgb(${accent} / 0.18)` }}
      />
      <span
        className="absolute rounded-full border"
        style={{
          inset: size * 0.22,
          borderColor: `rgb(${accent} / 0.14)`,
        }}
      />

      {/* The sweep itself. */}
      <span
        className="radar-sweep absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(from 0deg, transparent 0deg, transparent 300deg, rgb(${accent} / 0.28) 355deg, rgb(${accent} / 0.02) 360deg)`,
        }}
      />

      {/* Centre mark, so the whole thing has a focal point. */}
      <span
        className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ background: `rgb(${accent} / 0.7)` }}
      />
    </div>
  );
}
