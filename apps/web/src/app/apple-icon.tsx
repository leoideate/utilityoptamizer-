import { ImageResponse } from "next/og";
import { BRAND_GREEN, RING_DOTS } from "@/components/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon (phones and tablets): the mark on white, as iOS doesn't allow transparency. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#ffffff" }}>
        <svg viewBox="0 0 100 100" width={140} height={140} fill={BRAND_GREEN}>
          {RING_DOTS.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={d.r} />
          ))}
        </svg>
      </div>
    ),
    size,
  );
}
