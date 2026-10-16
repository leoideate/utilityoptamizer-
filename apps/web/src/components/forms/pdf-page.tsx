"use client";

import { useQuery } from "@tanstack/react-query";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/primitives";

let lib: Promise<typeof import("pdfjs-dist")> | null = null;
/** pdf.js is large, so it loads only when a PDF is shown. Its worker is served from this origin (CSP worker-src 'self'). */
function pdfjs() {
  lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return m;
  });
  return lib;
}

/** Loads a PDF from the API (same origin, session cookie). */
export function usePdf(path: string | null) {
  return useQuery({
    queryKey: ["pdf", path],
    enabled: !!path,
    staleTime: Infinity,
    queryFn: async (): Promise<PDFDocumentProxy> => {
      const res = await fetch(`/api${path}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error("The PDF couldn't be loaded.");
      const m = await pdfjs();
      return m.getDocument({ data: new Uint8Array(await res.arrayBuffer()), isEvalSupported: false }).promise;
    },
  });
}

/** A box in PDF points (origin bottom-left) converted to CSS pixels on the rendered page. */
export function toScreen(viewport: PageViewport, r: { x: number; y: number; w: number; h: number }) {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h]);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** A CSS-pixel point on the rendered page converted to PDF points. */
export function toPdf(viewport: PageViewport, left: number, top: number) {
  const [x, y] = viewport.convertToPdfPoint(left, top);
  return { x, y };
}

/**
 * Renders one page at the width of its container. `overlay` receives the viewport so callers can
 * position boxes over the page.
 */
export function PdfPage({ doc, page, overlay, label }: { doc: PDFDocumentProxy; page: number; overlay?: (viewport: PageViewport) => ReactNode; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState<PageViewport | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!width || !canvas.current) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      const p = await doc.getPage(page + 1);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: width / base.width });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current!;
      c.width = Math.floor(vp.width * ratio);
      c.height = Math.floor(vp.height * ratio);
      c.style.width = `${vp.width}px`;
      c.style.height = `${vp.height}px`;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const t = p.render({ canvasContext: ctx, viewport: vp });
      task = t;
      try {
        await t.promise;
        if (!cancelled) setViewport(vp);
      } catch {
        // Cancelled by a newer render.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, width]);

  return (
    <div ref={wrap} className="relative w-full min-w-0 overflow-hidden rounded-lg border border-border bg-white">
      <canvas ref={canvas} role="img" aria-label={label} className="block" />
      {!viewport && <Skeleton className="absolute inset-0" />}
      {viewport && overlay?.(viewport)}
    </div>
  );
}
