import { useState, useEffect, Fragment } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AUTOMATED_SHORTS_MAX_TABS } from "@shared/project-limits";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2, Plus, Play, Library, RefreshCw, Film, ClipboardPaste, Sparkles, Wand2, X, Image as ImageIcon,
} from "lucide-react";
import { type Project } from "@shared/schema";
import { motion, AnimatePresence } from "framer-motion";
import { apiRequest } from "@/lib/queryClient";
import { ProjectCard } from "@/components/ProjectCard";
import { PaginatedProjectList } from "@/components/paginated-project-list";
import { LogoLayoutEditor } from "@/components/logo-layout-editor";

type Asset = { id: number; name: string; url?: string };
type Row = {
  projectName: string;
  fullVideoUrl: string;
  fullVideoFile: File | null;
  isVerticalSource: boolean;
  cropType: string;
};

type LogoLayout = { xPct: number; yPct: number; widthPct: number; opacity: number };
type VProfile = {
  name?: string;
  captionStyle: string;
  mirror: boolean;
  noise: number;
  logoPosition: "top-left" | "top-right";
  musicMood: string;
  topCard: boolean;
  outro: boolean;
  hookText?: string;
  outroText?: string;
  logoLayout?: LogoLayout;
  logoAssetId?: number | null;
  hookColor?: string;
};
type VSlot = { kind: "nv" | "vo"; index: number; profile: VProfile };
type PlanResult = {
  batchId: string;
  baseName: string;
  durationSec: number;
  detectedMood: string;
  sharedTitle: string;
  targetSeconds: number;
  variants: VSlot[];
};

const DURATION_OPTIONS = [25, 35, 45, 60] as const;
const CAPTION_STYLES = ["capcut_green", "capcut_yellow", "neon_pop", "minimal_white", "fire", "gradient_glow"];
const MOODS = ["auto", "epic", "emotional", "uplifting", "dramatic", "energetic", "happy", "chill", "dark", "none"];
const DEFAULT_LOGO_LAYOUT: LogoLayout = { xPct: 0.95, yPct: 0.05, widthPct: 0.18, opacity: 1 };
// Headline (top-card) text colors. rgb is stored; the swatch previews it.
const HOOK_COLORS = [
  { name: "Purple", rgb: "A020F0" },
  { name: "Blue", rgb: "2E7DFF" },
  { name: "Orange", rgb: "FF7A00" },
  { name: "Red", rgb: "FF2D2D" },
  { name: "Green", rgb: "1FBF4B" },
  { name: "Pink", rgb: "FF45A8" },
  { name: "Teal", rgb: "12C2C2" },
  { name: "White", rgb: "FFFFFF" },
  { name: "Black", rgb: "151515" },
];

function initialRow(): Row {
  return { projectName: "", fullVideoUrl: "", fullVideoFile: null, isVerticalSource: false, cropType: "none" };
}

export default function AutomatedShortsFactoryPage() {
  const { toast } = useToast();
  const [bgMusic, setBgMusic] = useState<File | null>(null);
  const [bgMusicAssetId, setBgMusicAssetId] = useState<string | undefined>();
  const [logo, setLogo] = useState<File | null>(null);
  const [logoAssetId, setLogoAssetId] = useState<string | undefined>();
  const [targetSeconds, setTargetSeconds] = useState(35);
  const [rows, setRows] = useState<Row[]>([initialRow()]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [plans, setPlans] = useState<PlanResult[] | null>(null);
  const [bulkLogoId, setBulkLogoId] = useState("");
  const [bulkLogoPos, setBulkLogoPos] = useState<"top-left" | "top-right">("top-right");
  const [bulkLogoLayout, setBulkLogoLayout] = useState<LogoLayout | undefined>(undefined);
  const [logoEditorOpen, setLogoEditorOpen] = useState(false);

  // Pre-fill the bulk-logo position from the saved default (set via the drag editor).
  useEffect(() => {
    fetch("/api/factory/default-logo-layout", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (d?.layout) setBulkLogoLayout(d.layout); })
      .catch(() => {});
  }, []);

  const { data: bgMusicAssets = [], refetch: refetchBgMusic } = useQuery<Asset[]>({ queryKey: ["/api/assets/bg-music"] });
  const { data: logoAssets = [] } = useQuery<Asset[]>({ queryKey: ["/api/assets/logos"] });
  const { data: projects = [], isLoading } = useQuery<Project[]>({ queryKey: ["/api/projects"], refetchInterval: 3000 });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/projects/${id}`); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/projects"] }),
  });
  const retryMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("POST", `/api/projects/${id}/retry`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/projects"] }); toast({ title: "Retrying…" }); },
    onError: (e: any) => toast({ title: "Retry failed", description: e?.message, variant: "destructive" }),
  });

  const addRow = () => {
    if (rows.length >= AUTOMATED_SHORTS_MAX_TABS) return;
    setRows((p) => [...p, initialRow()]);
  };
  const removeRow = (i: number) => rows.length > 1 && setRows((p) => p.filter((_, j) => j !== i));
  const updateRow = (i: number, u: Partial<Row>) => setRows((p) => p.map((r, j) => (j === i ? { ...r, ...u } : r)));

  // Step 1: build the plan — download/probe each source and return the editable
  // list of variant slots (no projects created yet).
  const planMutation = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      if (bgMusic) fd.append("bgMusic", bgMusic);
      if (bgMusicAssetId) fd.append("bgMusicAssetId", bgMusicAssetId);
      if (logo) fd.append("logo", logo);
      if (logoAssetId) fd.append("logoAssetId", logoAssetId);
      fd.append("targetSeconds", String(targetSeconds));
      fd.append("tabs", JSON.stringify(rows.map((r) => ({
        projectName: r.projectName.trim() || undefined,
        fullVideoUrl: r.fullVideoUrl.trim() || undefined,
        isVerticalSource: r.isVerticalSource,
        cropType: r.cropType,
      }))));
      for (let i = 0; i < rows.length; i++) if (rows[i].fullVideoFile) fd.append(`fullVideo_${i}`, rows[i].fullVideoFile!);
      const res = await fetch("/api/factory/plan", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      return res.json();
    },
    onSuccess: (d: { plans: PlanResult[] }) => {
      setPlans(d.plans || []);
      toast({ title: "Plan ready", description: `Review & edit ${(d.plans || []).reduce((n, p) => n + p.variants.length, 0)} variant(s), then Generate.` });
    },
    onError: (e: Error) => toast({ title: "Plan failed", description: e.message, variant: "destructive" }),
  });

  // Step 2: generate from the (edited) plan.
  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/factory/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ plans: (plans || []).map((p) => ({ batchId: p.batchId, variants: p.variants })) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
      }
      return res.json();
    },
    onSuccess: (d: { batches: string[] }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      toast({ title: "Factory started", description: `${d.batches.length} source(s) → generating variants in background.` });
      setPlans(null);
      setRows([initialRow()]);
    },
    onError: (e: Error) => toast({ title: "Generate failed", description: e.message, variant: "destructive" }),
  });

  const updateSlot = (planIdx: number, slotIdx: number, profile: VProfile) => {
    setPlans((prev) => prev && prev.map((p, pi) => pi !== planIdx ? p : {
      ...p, variants: p.variants.map((v, vi) => vi === slotIdx ? { ...v, profile } : v),
    }));
  };

  // Bulk-apply the chosen logo + position to every variant in a scope.
  const applyBulkLogo = (scope: "all" | "vo" | "nv") => {
    const id = bulkLogoId ? Number(bulkLogoId) : null;
    setPlans((prev) => prev && prev.map((p) => ({
      ...p,
      variants: p.variants.map((v) =>
        (scope === "all" || v.kind === scope)
          ? { ...v, profile: { ...v.profile, logoAssetId: id, logoPosition: bulkLogoPos, logoLayout: bulkLogoLayout } }
          : v
      ),
    })));
    const label = scope === "all" ? "all variants" : scope.toUpperCase() + " only";
    const name = id ? (logoAssets.find((a) => a.id === id)?.name || "logo") : "run default";
    toast({ title: "Logo applied", description: `“${name}” → ${label}` });
  };

  // Persist the current bulk position as the always-default (drag editor).
  const saveDefaultLayout = (layout: LogoLayout) => {
    fetch("/api/factory/default-logo-layout", {
      method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ layout }),
    })
      .then((r) => { if (!r.ok) throw new Error(); toast({ title: "Saved", description: "This logo position is now the default." }); })
      .catch(() => toast({ title: "Failed to save default", variant: "destructive" }));
  };

  const addBgMusicMutation = useMutation({
    mutationFn: async (files: FileList) => {
      const fd = new FormData();
      for (let i = 0; i < files.length; i++) fd.append("files", files[i]);
      const res = await fetch("/api/assets/bg-music", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      return res.json();
    },
    onSuccess: () => { refetchBgMusic(); toast({ title: "Added to library" }); },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const canRun = rows.every((r) => r.fullVideoUrl.trim() || r.fullVideoFile) && !planMutation.isPending;
  const factoryProjects = projects.filter((p) => (p as any).batchId);

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Automated Shorts Factory</h1>
        <p className="text-sm text-muted-foreground mt-1">
          One source video → several unique shorts (no-voiceover + voiceover) based on duration. Configure counts & variant styles in Settings.
        </p>
      </div>

      <Card className="p-6 space-y-5">
        <h2 className="font-semibold">Shared</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Background Music (optional — auto music by default)</label>
            <div className="flex gap-2">
              <Select value={bgMusic ? "" : (bgMusicAssetId ?? "")} onValueChange={(v) => { setBgMusic(null); setBgMusicAssetId(v || undefined); }}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Saved tracks or upload" /></SelectTrigger>
                <SelectContent>{bgMusicAssets.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" onClick={() => {
                const input = document.createElement("input"); input.type = "file"; input.accept = "audio/*";
                input.onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { setBgMusic(f); setBgMusicAssetId(undefined); } }; input.click();
              }}>{bgMusic ? "Change" : "Upload"}</Button>
              <Button type="button" variant="outline" size="sm" className="gap-1" title="Add to library" onClick={() => {
                const input = document.createElement("input"); input.type = "file"; input.accept = "audio/*"; input.multiple = true;
                input.onchange = (e) => { const f = (e.target as HTMLInputElement).files; if (f?.length) addBgMusicMutation.mutate(f); }; input.click();
              }}><Library className="w-4 h-4" /></Button>
            </div>
            {bgMusic && <Badge variant="secondary" className="text-xs">{bgMusic.name}</Badge>}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Logo (optional)</label>
            <div className="flex gap-2">
              <Select value={logo ? "" : (logoAssetId ?? "")} onValueChange={(v) => { setLogo(null); setLogoAssetId(v || undefined); }}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Saved logos or upload" /></SelectTrigger>
                <SelectContent>{logoAssets.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" onClick={() => {
                const input = document.createElement("input"); input.type = "file"; input.accept = "image/*";
                input.onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { setLogo(f); setLogoAssetId(undefined); } }; input.click();
              }}>{logo ? "Change" : "Upload"}</Button>
            </div>
            {logo && <Badge variant="secondary" className="text-xs">{logo.name}</Badge>}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Target duration per short</label>
          <div className="flex flex-wrap gap-2">
            {DURATION_OPTIONS.map((s) => (
              <Button key={s} type="button" variant={targetSeconds === s ? "default" : "outline"} size="sm" onClick={() => setTargetSeconds(s)}>{s}s</Button>
            ))}
          </div>
        </div>
      </Card>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Source videos</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{rows.length}/{AUTOMATED_SHORTS_MAX_TABS}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setBulkOpen(true)} className="gap-1" disabled={rows.length >= AUTOMATED_SHORTS_MAX_TABS}>
              <ClipboardPaste className="w-4 h-4" />Bulk Paste
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={addRow} className="gap-1" disabled={rows.length >= AUTOMATED_SHORTS_MAX_TABS}>
              <Plus className="w-4 h-4" />Add
            </Button>
          </div>
        </div>

        <BulkPasteDialog open={bulkOpen} onOpenChange={setBulkOpen} maxRows={AUTOMATED_SHORTS_MAX_TABS - rows.length}
          onImport={(imp) => {
            setRows((p) => [...p, ...imp.map((r) => ({ ...initialRow(), projectName: r.name, fullVideoUrl: r.url, isVerticalSource: r.vertical }))]);
            setBulkOpen(false);
          }} />

        {rows.map((row, i) => (
          <Card key={i} className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Source {i + 1}</span>
              {rows.length > 1 && <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => removeRow(i)}>Remove</Button>}
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="space-y-2 flex-1">
                <label className="text-xs font-medium text-muted-foreground">Name (optional)</label>
                <Input placeholder={`Source ${i + 1}`} value={row.projectName} onChange={(e) => updateRow(i, { projectName: e.target.value })} className="max-w-xs" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id={`v-${i}`} checked={row.isVerticalSource} onChange={(e) => updateRow(i, { isVerticalSource: e.target.checked })} className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary" />
                <label htmlFor={`v-${i}`} className="text-sm cursor-pointer">Already 9:16</label>
              </div>
              <Select value={row.cropType} onValueChange={(val) => updateRow(i, { cropType: val })}>
                <SelectTrigger className="w-40 h-9 text-xs"><SelectValue placeholder="Crop" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No crop (sandwich)</SelectItem>
                  <SelectItem value="16:9">Horizontal (16:9)</SelectItem>
                  <SelectItem value="1:1">Square (1:1)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Source video (URL or file) *</label>
              <div className="flex gap-2">
                <Input placeholder="https://... or upload" value={row.fullVideoUrl} onChange={(e) => updateRow(i, { fullVideoUrl: e.target.value })} className="flex-1" />
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  const input = document.createElement("input"); input.type = "file"; input.accept = "video/*";
                  input.onchange = (e) => updateRow(i, { fullVideoFile: (e.target as HTMLInputElement).files?.[0] || null }); input.click();
                }}>{row.fullVideoFile ? row.fullVideoFile.name.slice(0, 12) + "…" : "Upload"}</Button>
              </div>
            </div>
          </Card>
        ))}

        {!plans && (
          <Button className="gap-2" onClick={() => planMutation.mutate()} disabled={!canRun}>
            {planMutation.isPending ? <><Loader2 className="w-4 h-4 animate-spin" />Building plan…</> : <><Sparkles className="w-4 h-4" />Build plan</>}
          </Button>
        )}
      </div>

      {plans && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold flex items-center gap-2"><Wand2 className="w-4 h-4 text-amber-500" />Plan — review & edit each variant</h2>
              <p className="text-xs text-muted-foreground mt-1">{plans.reduce((n, p) => n + p.variants.length, 0)} short(s) across {plans.length} source(s). Tweak anything, then Generate.</p>
            </div>
            <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground" onClick={() => setPlans(null)} disabled={generateMutation.isPending}>
              <X className="w-4 h-4" />Start over
            </Button>
          </div>

          {/* Bulk logo — pick a saved logo + position, apply to all / VO / NV at once. */}
          <Card className="p-4 space-y-3 border-amber-500/30">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-amber-500" />
              <span className="font-medium text-sm">Bulk logo</span>
              <span className="text-xs text-muted-foreground">— set one logo + position, apply to a group</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select value={bulkLogoId} onChange={(e) => setBulkLogoId(e.target.value)} className="h-8 rounded border border-input bg-background px-2">
                <option value="">(run default / none)</option>
                {logoAssets.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
              </select>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">pos:</span>
                <Button type="button" size="sm" variant={bulkLogoPos === "top-left" ? "default" : "outline"} className="h-8 px-2" onClick={() => setBulkLogoPos("top-left")}>↖</Button>
                <Button type="button" size="sm" variant={bulkLogoPos === "top-right" ? "default" : "outline"} className="h-8 px-2" onClick={() => setBulkLogoPos("top-right")}>↗</Button>
              </div>
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1" onClick={() => { if (!bulkLogoLayout) setBulkLogoLayout(DEFAULT_LOGO_LAYOUT); setLogoEditorOpen(true); }}>
                <ImageIcon className="w-3.5 h-3.5" />Drag…
              </Button>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={!!bulkLogoLayout} onChange={(e) => setBulkLogoLayout(e.target.checked ? DEFAULT_LOGO_LAYOUT : undefined)} />
                custom pos
              </label>
              {bulkLogoLayout && (
                <>
                  <label className="flex items-center gap-1">w%<input type="number" min={2} max={60} value={Math.round(bulkLogoLayout.widthPct * 100)} onChange={(e) => setBulkLogoLayout({ ...bulkLogoLayout, widthPct: Number(e.target.value) / 100 })} className="w-12 h-8 rounded border border-input bg-background px-1" /></label>
                  <label className="flex items-center gap-1">op%<input type="number" min={0} max={100} value={Math.round(bulkLogoLayout.opacity * 100)} onChange={(e) => setBulkLogoLayout({ ...bulkLogoLayout, opacity: Number(e.target.value) / 100 })} className="w-12 h-8 rounded border border-input bg-background px-1" /></label>
                  <label className="flex items-center gap-1">x%<input type="number" min={0} max={100} value={Math.round(bulkLogoLayout.xPct * 100)} onChange={(e) => setBulkLogoLayout({ ...bulkLogoLayout, xPct: Number(e.target.value) / 100 })} className="w-12 h-8 rounded border border-input bg-background px-1" /></label>
                  <label className="flex items-center gap-1">y%<input type="number" min={0} max={100} value={Math.round(bulkLogoLayout.yPct * 100)} onChange={(e) => setBulkLogoLayout({ ...bulkLogoLayout, yPct: Number(e.target.value) / 100 })} className="w-12 h-8 rounded border border-input bg-background px-1" /></label>
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => applyBulkLogo("all")}>Apply to all</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => applyBulkLogo("vo")}>Apply to VO</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => applyBulkLogo("nv")}>Apply to NV</Button>
              {logoAssets.length === 0 && <span className="text-xs text-muted-foreground self-center">No saved logos — upload one in the Shared section above or Settings.</span>}
            </div>
            <LogoLayoutEditor
              open={logoEditorOpen}
              onOpenChange={setLogoEditorOpen}
              logoUrl={logoAssets.find((a) => String(a.id) === bulkLogoId)?.url || null}
              value={bulkLogoLayout || DEFAULT_LOGO_LAYOUT}
              onChange={setBulkLogoLayout}
              onSaveDefault={saveDefaultLayout}
            />
          </Card>

          {plans.map((plan, pi) => (
            <Card key={plan.batchId} className="p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{plan.baseName}</span>
                {plan.durationSec < 9000 && <Badge variant="outline" className="text-[10px]">{Math.round(plan.durationSec)}s source</Badge>}
                {plan.detectedMood && <Badge variant="outline" className="text-[10px]">mood: {plan.detectedMood}</Badge>}
                <Badge variant="outline" className="text-[10px]">{plan.targetSeconds}s each</Badge>
                <span className="text-[10px] text-muted-foreground">hooks & music auto-generated on Generate</span>
              </div>
              {plan.variants.length === 0 ? (
                <p className="text-xs text-muted-foreground">No variants for this source (check duration rules / profiles in Settings).</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {plan.variants.map((slot, vi) => (
                    <VariantEditor key={`${slot.kind}-${slot.index}`} slot={slot} sharedTitle={plan.sharedTitle}
                      logoAssets={logoAssets} onChange={(p) => updateSlot(pi, vi, p)} />
                  ))}
                </div>
              )}
            </Card>
          ))}

          <Button className="gap-2" onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending || plans.every((p) => p.variants.length === 0)}>
            {generateMutation.isPending ? <><Loader2 className="w-4 h-4 animate-spin" />Generating…</> : <><Play className="w-4 h-4" />Generate {plans.reduce((n, p) => n + p.variants.length, 0)} short(s)</>}
          </Button>
        </div>
      )}

      <div className="mt-12 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Generated Variants</h2>
            <p className="text-sm text-muted-foreground mt-1">All shorts produced by the factory</p>
          </div>
          <Button variant="outline" size="sm" className="h-8 gap-2 text-xs" onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/projects"] })}>
            <RefreshCw className="w-3 h-3" />Refresh
          </Button>
        </div>
        {isLoading ? (
          <Card className="p-5"><div className="animate-pulse h-10 bg-muted rounded" /></Card>
        ) : factoryProjects.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4"><Film className="w-8 h-8 text-muted-foreground" /></div>
            <h3 className="font-semibold text-muted-foreground">No factory variants yet</h3>
            <p className="text-sm text-muted-foreground mt-1">Run the factory to see generated shorts here</p>
          </motion.div>
        ) : (
          <PaginatedProjectList
            projects={factoryProjects}
            onDelete={(id) => deleteMutation.mutate(id)}
            onRetry={(id) => retryMutation.mutate(id)}
          />
        )}
      </div>
    </div>
  );
}

function VariantEditor({ slot, sharedTitle, logoAssets, onChange }: { slot: VSlot; sharedTitle: string; logoAssets: Asset[]; onChange: (p: VProfile) => void }) {
  const p = slot.profile;
  const upd = (patch: Partial<VProfile>) => onChange({ ...p, ...patch });
  const ll = p.logoLayout;
  const updLogo = (patch: Partial<LogoLayout>) => upd({ logoLayout: { ...(ll || DEFAULT_LOGO_LAYOUT), ...patch } });
  const inp = "h-7 rounded border border-input bg-background px-1";
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={slot.kind === "nv" ? "secondary" : "default"} className="text-[10px] uppercase">{slot.kind} {slot.index}</Badge>
        <select value={p.captionStyle} onChange={(e) => upd({ captionStyle: e.target.value })} className={inp}>
          {CAPTION_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={p.logoPosition} onChange={(e) => upd({ logoPosition: e.target.value as any })} className={inp}>
          <option value="top-right">↗ logo</option>
          <option value="top-left">↖ logo</option>
        </select>
        <select value={p.musicMood} onChange={(e) => upd({ musicMood: e.target.value })} className={inp}>
          {MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={p.mirror} onChange={(e) => upd({ mirror: e.target.checked })} />mirror</label>
        <label className="flex items-center gap-1">noise<input type="number" min={0} max={20} value={p.noise} onChange={(e) => upd({ noise: Number(e.target.value) })} className={`w-12 ${inp}`} /></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={p.topCard} onChange={(e) => upd({ topCard: e.target.checked })} />card</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={p.outro} onChange={(e) => upd({ outro: e.target.checked })} />outro</label>
      </div>
      {p.topCard && (
        <div className="flex items-center gap-2">
          <input value={p.hookText || ""} onChange={(e) => upd({ hookText: e.target.value })} placeholder={sharedTitle ? `Hook — blank = “${sharedTitle.slice(0, 40)}”` : "Hook text — blank = AI"} className={`flex-1 ${inp} px-2`} />
          <span className="w-4 h-4 rounded border border-border shrink-0" style={{ backgroundColor: `#${p.hookColor || "A020F0"}` }} title="Headline color" />
          <select value={p.hookColor || "A020F0"} onChange={(e) => upd({ hookColor: e.target.value })} className={inp} title="Headline color">
            {HOOK_COLORS.map((c) => <option key={c.rgb} value={c.rgb}>{c.name}</option>)}
          </select>
        </div>
      )}
      {p.outro && (
        <input value={p.outroText || ""} onChange={(e) => upd({ outroText: e.target.value })} placeholder="Outro — blank = “Full video in the comments”" className={`w-full ${inp} px-2`} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={p.logoAssetId ? String(p.logoAssetId) : ""} onChange={(e) => upd({ logoAssetId: e.target.value ? Number(e.target.value) : null })} className={inp} title="Logo image">
          <option value="">logo: default</option>
          {logoAssets.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!ll} onChange={(e) => upd({ logoLayout: e.target.checked ? DEFAULT_LOGO_LAYOUT : undefined })} />
          custom logo
        </label>
        {ll && (
          <>
            <label className="flex items-center gap-1">w%<input type="number" min={2} max={60} value={Math.round(ll.widthPct * 100)} onChange={(e) => updLogo({ widthPct: Number(e.target.value) / 100 })} className={`w-12 ${inp}`} /></label>
            <label className="flex items-center gap-1">op%<input type="number" min={0} max={100} value={Math.round(ll.opacity * 100)} onChange={(e) => updLogo({ opacity: Number(e.target.value) / 100 })} className={`w-12 ${inp}`} /></label>
            <label className="flex items-center gap-1">x%<input type="number" min={0} max={100} value={Math.round(ll.xPct * 100)} onChange={(e) => updLogo({ xPct: Number(e.target.value) / 100 })} className={`w-12 ${inp}`} /></label>
            <label className="flex items-center gap-1">y%<input type="number" min={0} max={100} value={Math.round(ll.yPct * 100)} onChange={(e) => updLogo({ yPct: Number(e.target.value) / 100 })} className={`w-12 ${inp}`} /></label>
          </>
        )}
      </div>
    </div>
  );
}

type BulkRow = { url: string; name: string; vertical: boolean };
const EMPTY = (): BulkRow => ({ url: "", name: "", vertical: false });

function BulkPasteDialog({ open, onOpenChange, onImport, maxRows }: {
  open: boolean; onOpenChange: (v: boolean) => void; onImport: (rows: BulkRow[]) => void; maxRows: number;
}) {
  const [rows, setRows] = useState<BulkRow[]>(() => Array.from({ length: 5 }, EMPTY));
  const update = (i: number, f: keyof BulkRow, v: string | boolean) => setRows((p) => { const n = [...p]; n[i] = { ...n[i], [f]: v }; return n; });

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>, startRow: number, startCol: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    e.preventDefault();
    const lines = text.split("\n").filter((l) => l.trim());
    const cols: Array<keyof BulkRow> = ["url", "name", "vertical"];
    setRows((prev) => {
      const next = [...prev];
      lines.forEach((line, pi) => {
        const ri = startRow + pi;
        while (next.length <= ri && next.length < maxRows) next.push(EMPTY());
        if (ri >= maxRows) return;
        const ex = { ...(next[ri] || EMPTY()) };
        line.split("\t").forEach((val, ci) => {
          const key = cols[startCol + ci];
          if (!key) return;
          if (key === "vertical") ex.vertical = ["yes", "1", "true", "da"].includes(val.trim().toLowerCase());
          else (ex as any)[key] = val.trim();
        });
        next[ri] = ex;
      });
      return next;
    });
  };

  const filled = rows.filter((r) => r.url.trim());
  const inputCls = "h-8 w-full border-0 rounded-none bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ClipboardPaste className="w-5 h-5" />Bulk Paste sources</DialogTitle>
          <DialogDescription>Paste from a spreadsheet. Columns: <code className="px-1 bg-muted rounded text-xs">URL → Name → Vertical</code></DialogDescription>
        </DialogHeader>
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead><tr className="bg-muted">
              <th className="w-8 px-2 py-2 text-center text-xs border-r border-border">#</th>
              <th className="px-2 py-2 text-left text-xs border-r border-border min-w-[260px]">Source URL</th>
              <th className="px-2 py-2 text-left text-xs border-r border-border w-[140px]">Name</th>
              <th className="w-12 px-2 py-2 text-center text-xs border-border" title="Already 9:16">V</th>
            </tr></thead>
            <tbody>
              {rows.map((row, i) => (
                <Fragment key={i}>
                  <tr className="border-t border-border">
                    <td className="text-center text-xs text-muted-foreground border-r border-border">{i + 1}</td>
                    <td className="border-r border-border p-0"><input className={inputCls} value={row.url} placeholder="https://..." onChange={(e) => update(i, "url", e.target.value)} onPaste={(e) => handlePaste(e, i, 0)} /></td>
                    <td className="border-r border-border p-0"><input className={inputCls} value={row.name} placeholder="Name" onChange={(e) => update(i, "name", e.target.value)} onPaste={(e) => handlePaste(e, i, 1)} /></td>
                    <td className="text-center border-border py-0"><input type="checkbox" checked={row.vertical} onChange={(e) => update(i, "vertical", e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-primary" /></td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onImport(filled)} disabled={filled.length === 0} className="gap-1"><Plus className="w-4 h-4" />Import {filled.length || ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
