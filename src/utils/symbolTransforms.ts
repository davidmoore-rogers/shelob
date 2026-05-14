/**
 * src/utils/symbolTransforms.ts — Pure value-transform registry consumed by
 * the manufacturer-profile resolver and the Custom MIB tab.
 *
 * When an operator picks a vendor-specific MIB symbol whose units don't
 * match what Polaris stores natively (FortiOS reports temperature in
 * Celsius, but a chassis-monitor MIB might report Fahrenheit; some vendors
 * publish bytes where the chart expects MB), they pair the symbol with a
 * transform here. The probe path applies the transform after the SNMP
 * value lands and before the sample row is written.
 *
 * Pure (no I/O, no DB) so it can be exercised from unit tests trivially
 * and reused on the frontend if we ever need preview-time conversion.
 */

export type TransformKind =
  | "celsius_to_fahrenheit"
  | "fahrenheit_to_celsius"
  | "bytes_to_mb"
  | "bytes_to_gb"
  | "mb_to_bytes"
  | "ticks_to_seconds"
  | "ratio_to_percent"
  | "percent_to_ratio"
  | "signed_to_unsigned";

export const TRANSFORM_KINDS: TransformKind[] = [
  "celsius_to_fahrenheit",
  "fahrenheit_to_celsius",
  "bytes_to_mb",
  "bytes_to_gb",
  "mb_to_bytes",
  "ticks_to_seconds",
  "ratio_to_percent",
  "percent_to_ratio",
  "signed_to_unsigned",
];

export const TRANSFORM_LABELS: Record<TransformKind, string> = {
  celsius_to_fahrenheit: "Celsius → Fahrenheit",
  fahrenheit_to_celsius: "Fahrenheit → Celsius",
  bytes_to_mb:           "Bytes → MB",
  bytes_to_gb:           "Bytes → GB",
  mb_to_bytes:           "MB → Bytes",
  ticks_to_seconds:      "TimeTicks → Seconds",
  ratio_to_percent:      "Ratio (0..1) → Percent (0..100)",
  percent_to_ratio:      "Percent (0..100) → Ratio (0..1)",
  signed_to_unsigned:    "Signed Int32 → Unsigned (negative values shifted by 2³²)",
};

export function isTransformKind(value: unknown): value is TransformKind {
  return typeof value === "string" && (TRANSFORM_KINDS as string[]).includes(value);
}

/**
 * Apply the named transform to a raw numeric value. Returns the input
 * unchanged when `kind` is null/undefined or the value isn't a finite
 * number — null/non-numeric inputs flow through so an upstream "no data"
 * signal isn't silently coerced to 0.
 */
export function applyTransform(value: number | null | undefined, kind: TransformKind | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  if (!kind) return value;
  switch (kind) {
    case "celsius_to_fahrenheit": return value * 9 / 5 + 32;
    case "fahrenheit_to_celsius": return (value - 32) * 5 / 9;
    case "bytes_to_mb":           return value / (1024 * 1024);
    case "bytes_to_gb":           return value / (1024 * 1024 * 1024);
    case "mb_to_bytes":           return value * 1024 * 1024;
    case "ticks_to_seconds":      return value / 100; // SNMP TimeTicks are hundredths-of-a-second
    case "ratio_to_percent":      return value * 100;
    case "percent_to_ratio":      return value / 100;
    case "signed_to_unsigned":    return value < 0 ? value + 2 ** 32 : value;
    default:                      return value;
  }
}
