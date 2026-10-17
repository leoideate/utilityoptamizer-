import { ImageResponse } from "next/og";
import { BRAND_GREEN, RING_DOTS } from "@/components/brand";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** Browser-tab icon: the dotted-ring mark. */
export default function Icon() {
  return new ImageResponse(
    (
      <svg viewBox="0 0 100 100" width={64} height={64} fill={BRAND_GREEN}>
        {RING_DOTS.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r * 1.15} />
        ))}
      </svg>
    ),
    size,
  );
}
