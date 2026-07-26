import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { ProjectCard } from "@/components/ProjectCard";
import { cn } from "@/lib/utils";
import { type Project } from "@shared/schema";

// Local day index (days since epoch, in the browser's timezone).
function dayOrdinal(ts: unknown): number {
  const d = new Date((ts as string) || Date.now());
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round(local.getTime() / 86400000);
}
const ddmm = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;

type Bucket = { key: number; label: string; items: Project[] };

// Group projects into fixed 2-day calendar windows (e.g. 28–29, 30–31), most
// recent first. Only ONE window is rendered at a time so the browser never
// holds ~1000 heavy cards in memory.
function bucketByTwoDays(items: Project[]): Bucket[] {
  const map = new Map<number, Project[]>();
  for (const it of items) {
    const bk = Math.floor(dayOrdinal((it as any).createdAt) / 2);
    if (!map.has(bk)) map.set(bk, []);
    map.get(bk)!.push(it);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([key, list]: [number, Project[]]) => {
      const times = list.map((p: Project) => new Date((p as any).createdAt || Date.now()).getTime());
      const lo = new Date(Math.min(...times));
      const hi = new Date(Math.max(...times));
      const label = ddmm(lo) === ddmm(hi) ? ddmm(lo) : `${ddmm(lo)}–${ddmm(hi)}`;
      return { key, label, items: list };
    });
}

export function PaginatedProjectList({
  projects,
  onDelete,
  onRetry,
}: {
  projects: Project[];
  onDelete: (id: number) => void;
  onRetry: (id: number) => void;
}) {
  const buckets = useMemo(() => bucketByTwoDays(projects), [projects]);
  const [sel, setSel] = useState<number | null>(null);
  // Keep the selection valid; default to the most recent 2-day window.
  const selKey =
    sel != null && buckets.some((b) => b.key === sel) ? sel : buckets[0]?.key ?? null;
  const current = buckets.find((b) => b.key === selKey);

  return (
    <div className="space-y-4">
      {buckets.length > 1 && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground mr-1">By 2 days:</span>
          {buckets.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setSel(b.key)}
              className={cn(
                "px-3 py-1 rounded-full text-xs border transition-colors",
                b.key === selKey
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              )}
            >
              {b.label} <span className="opacity-70">({b.items.length})</span>
            </button>
          ))}
        </div>
      )}
      <AnimatePresence mode="popLayout">
        <div className="space-y-4">
          {(current?.items ?? []).map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onDelete={onDelete}
              onRetry={onRetry}
            />
          ))}
        </div>
      </AnimatePresence>
    </div>
  );
}
