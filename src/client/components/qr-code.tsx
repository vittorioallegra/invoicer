import { encode } from "uqr";

const QUIET_ZONE = 4;

/** Module matrix of `text` (true = dark), without any border. */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { border: 0, ecc: "M" }).data;
}

/**
 * QR code as an inline SVG. Always dark on white, whatever the theme, because scanners need
 * contrast. No data: URL or canvas, so the CSP stays unchanged.
 */
export function QrCode({
  text,
  label,
  size = 192,
}: {
  text: string;
  label: string;
  size?: number;
}) {
  const matrix = qrMatrix(text);
  const count = matrix.length;
  const full = count + QUIET_ZONE * 2;
  let path = "";
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${full} ${full}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="mx-auto max-w-full rounded-md"
    >
      <rect width={full} height={full} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
