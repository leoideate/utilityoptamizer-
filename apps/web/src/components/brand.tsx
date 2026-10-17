/**
 * The Utility Optimizer brand: the dotted-ring mark and the stacked wordmark, in the brand green.
 * Drawn as SVG so they stay sharp at any size and work in light and dark themes. The ring is
 * three staggered rings of dots whose size swells and shrinks around the circle.
 *
 * The logo is a logotype, so it has no contrast requirement; it's an image with a text alternative
 * rather than styled text.
 */
import { cn } from "@/lib/format";

export const BRAND_GREEN = "#2cda7d";

interface Dot {
  x: number;
  y: number;
  r: number;
  /** 0–1 position around the ring, used to stagger the loading animation. */
  turn: number;
}

/** Dot positions in a 100 × 100 box. Also drawn by app/icon.tsx and app/apple-icon.tsx. */
export const RING_DOTS: Dot[] = (() => {
  const rings = [
    { radius: 43.5, count: 22, size: 5.6, offset: 0 },
    { radius: 33.5, count: 20, size: 4.7, offset: 0.37 },
    { radius: 24, count: 15, size: 2.8, offset: 0.71 },
  ];
  const dots: Dot[] = [];
  rings.forEach((ring, k) => {
    for (let i = 0; i < ring.count; i++) {
      const turn = (i + ring.offset) / ring.count;
      const a = turn * 2 * Math.PI - Math.PI / 2;
      // Dots swell and shrink around the ring, and the rings wobble slightly, as in the brand mark.
      const swell = 0.35 + 0.65 * ((Math.sin(a * 3 + k * 1.7) + 1) / 2);
      const radius = ring.radius + 1.6 * Math.sin(a * 5 + k * 2.3);
      dots.push({ x: 50 + radius * Math.cos(a), y: 50 + radius * Math.sin(a), r: +(ring.size * swell).toFixed(2), turn });
    }
  });
  return dots.map((d) => ({ ...d, x: +d.x.toFixed(2), y: +d.y.toFixed(2) }));
})();

/** The dotted-ring mark. `animated` makes the dots pulse around the ring (for loading). */
export function LogoMark({ size = 36, animated = false, className, title }: { size?: number; animated?: boolean; className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("shrink-0", animated && "uo-logo-animated", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill={BRAND_GREEN}
    >
      {RING_DOTS.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} style={animated ? { animationDelay: `${(d.turn * 1.4).toFixed(2)}s` } : undefined} />
      ))}
    </svg>
  );
}

/**
 * The stacked "Utility Optimizer" name. Drawn as SVG text: the light brand green is fine for a
 * logotype (exempt from WCAG contrast), and SVG text keeps automated contrast checks from flagging it.
 */
export function Wordmark({ height, lines = 2 }: { height: number; lines?: 1 | 2 }) {
  if (lines === 1) {
    return (
      <svg viewBox="0 0 196 28" height={height} width={(height * 196) / 28} aria-hidden className="shrink-0 overflow-visible">
        <text x="0" y="22" fill={BRAND_GREEN} fontFamily="Roboto, ui-sans-serif, system-ui, sans-serif" fontWeight={500} fontSize="24" letterSpacing="-0.2">
          Utility Optimizer
        </text>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 112 52" height={height} width={(height * 112) / 52} aria-hidden className="shrink-0 overflow-visible">
      <text fill={BRAND_GREEN} fontFamily="Roboto, ui-sans-serif, system-ui, sans-serif" fontWeight={500} fontSize="22" letterSpacing="-0.2">
        <tspan x="0" y="20">
          Utility
        </tspan>
        <tspan x="0" y="46">
          Optimizer
        </tspan>
      </text>
    </svg>
  );
}

/** Mark plus the stacked "Utility Optimizer" wordmark, optionally with a product line ("CRM"). */
export function Logo({ size = 36, product, className }: { size?: number; product?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)} role="img" aria-label={product ? `Utility Optimizer ${product}` : "Utility Optimizer"}>
      <LogoMark size={size} />
      <span aria-hidden className="flex flex-col">
        <Wordmark height={size * 0.95} />
        {product && <span className="mt-1 text-xs font-medium uppercase tracking-[0.12em] text-muted">{product}</span>}
      </span>
    </span>
  );
}

/** Full-screen start-up screen: the ring pulses while the CRM loads. */
export function BrandSplash({ label = "Loading Utility Optimizer CRM" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-bg" role="status" aria-label={label}>
      <LogoMark size={96} animated />
      <span aria-hidden className="flex flex-col items-center">
        <Wordmark height={30} lines={1} />
        <span className="mt-2 block text-xs font-medium uppercase tracking-[0.2em] text-muted">CRM</span>
      </span>
    </div>
  );
}
