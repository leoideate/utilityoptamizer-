"use client";

import { Eraser } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/primitives";

/** Drawing size in canvas pixels. Kept small so the PNG fits the API's 100 KB request limit. */
const WIDTH = 600;
const HEIGHT = 200;
const INK = "#14183c";

export interface SignaturePadHandle {
  /** The drawing as a transparent PNG data URL, or null when nothing has been drawn. */
  toPng(): string | null;
}

/**
 * A signature box for mouse, touch and pen. Strokes are drawn with pointer events (so a finger
 * or stylus works the same as a mouse) and the page doesn't scroll while signing.
 */
export const SignaturePad = forwardRef<SignaturePadHandle, { label: string; onChange?: (hasInk: boolean) => void }>(function SignaturePad({ label, onChange }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  useImperativeHandle(ref, () => ({ toPng: () => (hasInk && canvas.current ? canvas.current.toDataURL("image/png") : null) }), [hasInk]);
  useEffect(() => onChange?.(hasInk), [hasInk, onChange]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * WIDTH, y: ((e.clientY - r.top) / r.height) * HEIGHT };
  };
  const ctx = () => {
    const c = canvas.current!.getContext("2d")!;
    c.strokeStyle = INK;
    c.fillStyle = INK;
    c.lineWidth = 3;
    c.lineCap = "round";
    c.lineJoin = "round";
    return c;
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    last.current = p;
    const c = ctx();
    c.beginPath();
    c.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    c.fill();
    setHasInk(true);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!last.current) return;
    const p = point(e);
    const c = ctx();
    c.beginPath();
    c.moveTo(last.current.x, last.current.y);
    c.lineTo(p.x, p.y);
    c.stroke();
    last.current = p;
  };
  const up = () => {
    last.current = null;
  };
  const clear = useCallback(() => {
    canvas.current?.getContext("2d")?.clearRect(0, 0, WIDTH, HEIGHT);
    setHasInk(false);
  }, []);

  return (
    <div className="space-y-2">
      <div className="relative rounded-lg border-2 border-dashed border-border bg-white">
        <canvas
          ref={canvas}
          width={WIDTH}
          height={HEIGHT}
          role="img"
          aria-label={label}
          className="block aspect-[3/1] w-full cursor-crosshair touch-none select-none rounded-lg"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={up}
        />
        {!hasInk && <span className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm text-muted">Sign here with your finger, a pen or the mouse</span>}
        <span className="pointer-events-none absolute inset-x-6 bottom-9 border-b border-border" aria-hidden />
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={clear} disabled={!hasInk}>
        <Eraser /> Clear
      </Button>
    </div>
  );
});
