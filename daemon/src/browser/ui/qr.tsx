import { useMemo } from "react";
import { encode } from "uqr";

export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 4 });
    let modules = "";
    qr.data.forEach((row, y) => { row.forEach((dark, x) => { if (dark) modules += `M${String(x)} ${String(y)}h1v1h-1z`; }); });
    return { size: qr.size, path: modules };
  }, [text]);
  return <svg className="qr-code" role="img" aria-label={label} viewBox={`0 0 ${String(size)} ${String(size)}`} shapeRendering="crispEdges">
    <rect className="qr-light" width={size} height={size} />
    <path className="qr-dark" d={path} />
  </svg>;
}
