import styles from "./sparkline.module.css";

export interface SparklineProps {
  /** Series in chronological order; fewer than 2 points renders nothing. */
  values: number[];
  width?: number;
  height?: number;
  /**
   * Accessible summary (e.g. "Spend, last 7 days"). Without it the SVG is
   * decorative and hidden from assistive tech — pass one when the sparkline
   * is the only representation of the data (DP-14).
   */
  label?: string;
}

/** Inline-SVG trend line, no dependencies (DP-14: every metric has a trend). */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  label,
}: SparklineProps) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2; // keep the stroke inside the viewBox

  const points = values
    .map((v, i) => {
      const x = pad + (i * (width - 2 * pad)) / (values.length - 1);
      const y = pad + (1 - (v - min) / range) * (height - 2 * pad);
      return `${round(x)},${round(y)}`;
    })
    .join(" ");

  return (
    <svg
      className={styles.sparkline}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
