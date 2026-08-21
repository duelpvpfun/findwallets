import type { AlertMcapSample } from "@/lib/db/schema";

/**
 * The market cap of an alerted token over the hours since it fired.
 *
 * A sparkline rather than a chart: it sits inside a feed row, carries no axes,
 * and its job is only to show the shape of what happened after the call. The
 * exact numbers are printed beside it, so nothing here has to be readable to
 * the pixel.
 *
 * The dashed rule is the cap at the moment the alert fired — the denominator of
 * every performance figure this alert will ever report — so the line being
 * above or below it is the whole story at a glance.
 */

const WIDTH = 132;
const HEIGHT = 34;
const PADDING = 3;

/** Peak marker and the current end-dot. Both carry a 2px surface ring so they
 * stay legible where they sit on top of the line. */
const SURFACE = "#0a0a0a";

export default function McapSparkline({
  samples,
  baselineUsd,
  up,
  className,
}: {
  samples: AlertMcapSample[];
  baselineUsd: number | null;
  /** Whether the token is above where it fired.
   *
   * Passed in rather than re-derived from the last sample, because the card
   * prints the same claim as a number and the two must not be able to
   * disagree. They did: `lastMcapUsd` and the final stored sample differ in the
   * last float digit, which was enough to draw a red line beside a green
   * figure. */
  up: boolean;
  className?: string;
}) {
  // Two points is the minimum that can draw a direction. One sample means the
  // alert fired within the last hour and nothing has been measured yet.
  const points = samples.filter(
    ([t, v]) => Number.isFinite(t) && Number.isFinite(v) && v > 0
  );
  if (points.length < 2) return null;

  const values = points.map(([, v]) => v);
  const candidates = baselineUsd && baselineUsd > 0 ? [...values, baselineUsd] : values;

  const minValue = Math.min(...candidates);
  const maxValue = Math.max(...candidates);

  /**
   * Flat is flat.
   *
   * Auto-scaling to the data's own range turns a market cap that moved 0.02%
   * into a dramatic mountain, because the range being scaled to is the noise.
   * Below half a percent of total spread the series is drawn as a flat line
   * down the middle, which is what actually happened.
   */
  const spread = maxValue > 0 ? (maxValue - minValue) / maxValue : 0;
  const flat = spread < 0.005;
  const spanValue = maxValue - minValue || 1;

  /**
   * x is the sample's INDEX, not its timestamp.
   *
   * Samples are written once an hour by the same cron, so index and time
   * spacing agree; and unlike time it cannot degenerate. Two samples taken in
   * the same second — which is exactly what the first hour of an alert's life
   * looks like — collapse a time scale to a single vertical spike.
   */
  const lastIndex = Math.max(1, points.length - 1);
  const x = (i: number) => PADDING + (i / lastIndex) * (WIDTH - PADDING * 2);
  const y = (v: number) =>
    flat
      ? HEIGHT / 2
      : HEIGHT - PADDING - ((v - minValue) / spanValue) * (HEIGHT - PADDING * 2);

  const line = points
    .map(([, v], i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(lastIndex).toFixed(1)},${HEIGHT - PADDING} L${x(0).toFixed(1)},${HEIGHT - PADDING} Z`;

  const lastPos = points.length - 1;
  const peakValue = Math.max(...values);
  const peakPos = values.indexOf(peakValue);
  const last = points[lastPos];

  // Status colours, and never carrying meaning alone: the figures printed
  // alongside this sparkline state the same thing in words and an arrow.
  const stroke = up ? "#0ca30c" : "#d03b3b";

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={className}
      role="img"
      aria-label="Market cap since the alert fired"
    >
      {/* The cap the alert fired at — the denominator of every figure beside
          this sparkline. Suppressed when the series is flat, where the line is
          already sitting on it and a second rule would just be visual noise. */}
      {baselineUsd && baselineUsd > 0 && !flat ? (
        <line
          x1={PADDING}
          x2={WIDTH - PADDING}
          y1={y(baselineUsd)}
          y2={y(baselineUsd)}
          stroke="#383835"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
      ) : null}

      <path d={area} fill={stroke} fillOpacity="0.1" />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {peakPos !== lastPos && peakPos >= 0 && !flat ? (
        <circle
          cx={x(peakPos)}
          cy={y(peakValue)}
          r="2.5"
          fill={stroke}
          stroke={SURFACE}
          strokeWidth="2"
        />
      ) : null}
      <circle cx={x(lastPos)} cy={y(last[1])} r="4" fill={stroke} stroke={SURFACE} strokeWidth="2" />
    </svg>
  );
}
