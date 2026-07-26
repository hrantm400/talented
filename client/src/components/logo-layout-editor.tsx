import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type Layout = { xPct: number; yPct: number; widthPct: number; opacity: number };
type Both = { take1: Layout; take2: Layout };

const CANVAS_W = 288;
const CANVAS_H = 512; // 9:16

const DEFAULTS: Both = {
  take1: { xPct: 0.35, yPct: 0.015, widthPct: 0.3, opacity: 1 },
  take2: { xPct: 0.04, yPct: 0.015, widthPct: 0.3, opacity: 1 },
};

export function LogoLayoutEditor({
  open,
  onOpenChange,
  logoUrl,
  value,
  onChange,
  onSaveDefault,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  logoUrl?: string | null;
  // Controlled single-layout mode (Factory bulk-logo bar). When `value` is
  // provided the editor drives ONE layout via onChange instead of the global
  // take1/take2 pair, and skips the global fetch/PUT.
  value?: Layout;
  onChange?: (l: Layout) => void;
  onSaveDefault?: (l: Layout) => void;
}) {
  const controlled = value !== undefined;
  const { toast } = useToast();
  const [layouts, setLayouts] = useState<Both>(DEFAULTS);
  const [single, setSingle] = useState<Layout>(value || DEFAULTS.take1);
  const [active, setActive] = useState<"take1" | "take2">("take1");
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<null | { mode: "move" | "resize"; offX: number; offY: number }>(null);

  useEffect(() => {
    if (!open) return;
    if (controlled) { setSingle(value || DEFAULTS.take1); return; }
    fetch("/api/logo-layout", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setLayouts({ take1: d.take1 || DEFAULTS.take1, take2: d.take2 || DEFAULTS.take2 }))
      .catch(() => setLayouts(DEFAULTS));
  }, [open]);

  const L = controlled ? single : layouts[active];
  const setL = (patch: Partial<Layout>) => {
    if (controlled) {
      const next = { ...single, ...patch };
      setSingle(next);
      onChange?.(next);
    } else {
      setLayouts((prev) => ({ ...prev, [active]: { ...prev[active], ...patch } }));
    }
  };

  const logoW = L.widthPct * CANVAS_W;
  const logoLeft = L.xPct * CANVAS_W;
  const logoTop = L.yPct * CANVAS_H;

  const onPointerDown = (e: React.PointerEvent, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvasRef.current!.getBoundingClientRect();
    drag.current = {
      mode,
      offX: e.clientX - rect.left - logoLeft,
      offY: e.clientY - rect.top - logoTop,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (drag.current.mode === "move") {
      let left = x - drag.current.offX;
      let top = y - drag.current.offY;
      left = Math.max(0, Math.min(CANVAS_W - logoW, left));
      top = Math.max(0, Math.min(CANVAS_H - 20, top));
      setL({ xPct: left / CANVAS_W, yPct: top / CANVAS_H });
    } else {
      let w = x - logoLeft;
      w = Math.max(CANVAS_W * 0.05, Math.min(CANVAS_W - logoLeft, w));
      setL({ widthPct: w / CANVAS_W });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/logo-layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(layouts),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      toast({ title: "Saved", description: "Logo placement saved as the default for everyone." });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Logo placement</DialogTitle>
          <DialogDescription>
            Drag to move, pull the corner to resize, slider for opacity. The dashed
            <span className="text-fuchsia-300"> Headline </span>box shows where the auto title sits — keep the logo clear of it.
            {controlled ? " Applies to the selected variants." : " Saved as the default for all videos."}
          </DialogDescription>
        </DialogHeader>

        {!controlled && (
          <div className="flex gap-2">
            {(["take1", "take2"] as const).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={active === t ? "default" : "outline"}
                onClick={() => setActive(t)}
              >
                {t === "take1" ? "Take 1" : "Take 2 (2x)"}
              </Button>
            ))}
          </div>
        )}

        <div className="flex justify-center">
          <div
            ref={canvasRef}
            className="relative rounded-md overflow-hidden border border-border bg-gradient-to-b from-zinc-700 to-zinc-900 select-none touch-none"
            style={{ width: CANVAS_W, height: CANVAS_H }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            {/* safe-zone hint */}
            <div className="absolute inset-x-0 top-0 h-px bg-white/10" />
            {/* Non-interactive ghost of the auto HEADLINE card (centered, top of
                the video). You don't edit it — it's just so the logo isn't
                placed under it. */}
            <div
              className="absolute rounded-md border border-dashed border-fuchsia-400/70 bg-fuchsia-400/15 flex items-center justify-center pointer-events-none z-10"
              style={{ left: 34, top: 5, width: 220, height: 74 }}
            >
              <span className="text-[8px] font-bold uppercase tracking-wider text-fuchsia-100/90">Headline</span>
            </div>
            <div
              className="absolute"
              style={{ left: logoLeft, top: logoTop, width: logoW, opacity: L.opacity, cursor: "move" }}
              onPointerDown={(e) => onPointerDown(e, "move")}
            >
              {logoUrl ? (
                <img src={logoUrl} alt="logo" className="w-full h-auto pointer-events-none" draggable={false} />
              ) : (
                <div className="w-full aspect-square bg-primary/30 border border-primary/60 rounded flex items-center justify-center text-[10px] text-white pointer-events-none">
                  LOGO
                </div>
              )}
              {/* resize handle */}
              <div
                className="absolute -right-1.5 -bottom-1.5 w-4 h-4 rounded-full bg-primary border-2 border-white"
                style={{ cursor: "nwse-resize" }}
                onPointerDown={(e) => onPointerDown(e, "resize")}
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-muted-foreground flex items-center justify-between">
            <span>Opacity</span>
            <span>{Math.round(L.opacity * 100)}%</span>
          </label>
          <input
            type="range"
            min={10}
            max={100}
            value={Math.round(L.opacity * 100)}
            onChange={(e) => setL({ opacity: Number(e.target.value) / 100 })}
            className="w-full"
          />
        </div>

        <DialogFooter>
          {controlled ? (
            <>
              {onSaveDefault && (
                <Button variant="outline" onClick={() => onSaveDefault(single)}>Save as default</Button>
              )}
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save as default"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
