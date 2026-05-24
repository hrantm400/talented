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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  Play,
  Library,
  Star,
  RefreshCw,
  Film,
  ClipboardPaste,
  AlertCircle,
} from "lucide-react";
import { PROJECT_TYPES, type Project } from "@shared/schema";
import { motion, AnimatePresence } from "framer-motion";
import { apiRequest } from "@/lib/queryClient";
import { ProjectCard } from "@/components/ProjectCard";

const DEFAULT_VOICE_KEY = "elevenlabs_default_voice_id";
import { CaptionStyleSelector } from "@/components/caption-styles";

type BgMusicAsset = { id: number; name: string };
type LogoAsset = { id: number; name: string };
type ElevenVoice = { voice_id: string; name: string; category?: string };

type TabState = {
  projectName: string;
  isVerticalSource: boolean;
  cropType: string;
  hookEnabled: boolean;
  twoTakes: boolean;
  /**
   * Optional override: when twoTakes is on, Take 2 will use this logo from
   * the user's Logo Assets library instead of the global logo selection.
   * null = use the global logo for both takes.
   */
  take2LogoAssetId: number | null;
  /** Logo overlay corner for Take 2 only. */
  take2LogoPosition: "top-right" | "top-left";
  fullVideoUrl: string;
  shortVideoUrl: string;
  fullVideoFile: File | null;
  shortVideoFile: File | null;
};

const DURATION_OPTIONS = [8, 10, 15, 20, 25, 30, 45, 60] as const;

function initialTab(): TabState {
  return {
    projectName: "",
    isVerticalSource: false,
    cropType: "none",
    hookEnabled: false,
    twoTakes: false,
    take2LogoAssetId: null,
    take2LogoPosition: "top-right",
    fullVideoUrl: "",
    shortVideoUrl: "",
    fullVideoFile: null,
    shortVideoFile: null,
  };
}

export default function AutomatedShortsPage() {
  const { toast } = useToast();
  const [bgMusic, setBgMusic] = useState<File | null>(null);
  const [bgMusicAssetId, setBgMusicAssetId] = useState<string | undefined>();
  const [logo, setLogo] = useState<File | null>(null);
  const [logoAssetId, setLogoAssetId] = useState<string | undefined>();
  const [captionStyle, setCaptionStyle] = useState("capcut_green");

  const { data: bgMusicAssets = [], refetch: refetchBgMusic } = useQuery<BgMusicAsset[]>({
    queryKey: ["/api/assets/bg-music"],
  });
  const { data: logoAssets = [], refetch: refetchLogos } = useQuery<LogoAsset[]>({
    queryKey: ["/api/assets/logos"],
  });
  const { data: voicesData } = useQuery<{ voices: ElevenVoice[] }>({
    queryKey: ["/api/elevenlabs/voices"],
  });
  const voices = voicesData?.voices ?? [];

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/projects/${id}/retry`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      toast({
        title: "Retrying…",
        description: "Pipeline restarted from the last successful step.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Retry failed",
        description: err?.message || "Could not start retry",
        variant: "destructive",
      });
    },
  });

  const [voiceId, setVoiceId] = useState<string | undefined>();
  // Sync with localStorage when voices load
  useEffect(() => {
    if (voices.length === 0) return;
    try {
      const stored = localStorage.getItem(DEFAULT_VOICE_KEY);
      const found = stored && voices.find((v) => v.voice_id === stored);
      setVoiceId((prev) => prev ?? (found ? found.voice_id : voices[0]?.voice_id));
    } catch {}
  }, [voices]);
  const [tabs, setTabs] = useState<TabState[]>([initialTab()]);
  const [targetSeconds, setTargetSeconds] = useState(20);
  const [videoType, setVideoType] = useState<"edited" | "raw">("raw");

  const [bulkOpen, setBulkOpen] = useState(false);

  const addTab = () => {
    if (tabs.length >= AUTOMATED_SHORTS_MAX_TABS) {
      toast({
        title: "Tab limit reached",
        description: `One batch supports up to ${AUTOMATED_SHORTS_MAX_TABS} tabs.`,
        variant: "destructive",
      });
      return;
    }

    setTabs((prev) => [...prev, initialTab()]);
  };

  const handleBulkImport = (rows: Array<{ name: string; fullUrl: string; shortUrl: string; vertical: boolean; hook: boolean; twoTakes: boolean; take2LogoAssetId: number | null; take2LogoPosition: "top-right" | "top-left" }>) => {
    const remaining = AUTOMATED_SHORTS_MAX_TABS - tabs.length;
    // Filter rows that have at least one URL
    const validRows = rows.filter((r) => r.fullUrl || r.shortUrl);
    const toImport = validRows.slice(0, remaining);
    if (toImport.length === 0) return;

    const newTabs: TabState[] = toImport.map((r, i) => ({
      ...initialTab(),
      projectName: r.name.trim() || `Automated Short ${tabs.length + i + 1}`,
      // Fallback: if one URL missing, copy from the other
      fullVideoUrl: r.fullUrl || r.shortUrl,
      shortVideoUrl: r.shortUrl || r.fullUrl,
      isVerticalSource: r.vertical,
      hookEnabled: r.hook,
      twoTakes: r.twoTakes,
      take2LogoAssetId: r.take2LogoAssetId,
      take2LogoPosition: r.take2LogoPosition,
    }));

    setTabs((prev) => [...prev, ...newTabs]);
    setBulkOpen(false);
    toast({
      title: "Bulk import",
      description: `${toImport.length} tab(s) added.${validRows.length > remaining ? ` ${validRows.length - remaining} skipped (limit ${AUTOMATED_SHORTS_MAX_TABS}).` : ""}`,
    });
  };

  const removeTab = (i: number) => {
    if (tabs.length <= 1) return;
    setTabs((prev) => prev.filter((_, j) => j !== i));
  };

  const updateTab = (i: number, upd: Partial<TabState>) => {
    setTabs((prev) => prev.map((t, j) => (j === i ? { ...t, ...upd } : t)));
  };

  const runMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      if (bgMusic) formData.append("bgMusic", bgMusic);
      if (bgMusicAssetId) formData.append("bgMusicAssetId", bgMusicAssetId);
      if (logo) formData.append("logo", logo);
      if (logoAssetId) formData.append("logoAssetId", logoAssetId);
      formData.append("targetSeconds", String(targetSeconds));
      formData.append("videoType", videoType);
      formData.append("captionStyle", captionStyle);
      if (voiceId) formData.append("voiceId", voiceId);

      const tabsPayload = tabs.map((t) => ({
        projectName: t.projectName.trim() || undefined,
        isVerticalSource: t.isVerticalSource,
        cropType: t.cropType,
        hookEnabled: t.hookEnabled,
        twoTakes: t.twoTakes,
        take2LogoAssetId: t.take2LogoAssetId,
        take2LogoPosition: t.take2LogoPosition,
        fullVideoUrl: t.fullVideoUrl.trim() || undefined,
        shortVideoUrl: t.shortVideoUrl.trim() || undefined,
      }));
      formData.append("tabs", JSON.stringify(tabsPayload));

      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].fullVideoFile) formData.append(`fullVideo_${i}`, tabs[i].fullVideoFile!);
        if (tabs[i].shortVideoFile) formData.append(`shortVideo_${i}`, tabs[i].shortVideoFile!);
      }

      const res = await fetch("/api/automated-shorts", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || res.statusText);
      }
      return res.json();
    },
    onSuccess: (data: { projects: Array<{ id: number; name: string }> }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      toast({
        title: "Pipeline started",
        description: `${data.projects.length} project(s) created. Processing in background.`,
      });
      setTabs([initialTab()]);
    },
    onError: (err: Error) => {
      toast({
        title: "Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const canRun =
    (bgMusic || bgMusicAssetId) &&
    tabs.length <= AUTOMATED_SHORTS_MAX_TABS &&
    tabs.every((t) => t.shortVideoUrl.trim() || t.shortVideoFile) &&
    !runMutation.isPending;

  const addBgMusicMutation = useMutation({
    mutationFn: async (files: FileList) => {
      const fd = new FormData();
      for (let i = 0; i < files.length; i++) fd.append("files", files[i]);
      const res = await fetch("/api/assets/bg-music", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      return res.json();
    },
    onSuccess: () => {
      refetchBgMusic();
      toast({ title: "Added to library" });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const addLogoMutation = useMutation({
    mutationFn: async (files: FileList) => {
      const fd = new FormData();
      for (let i = 0; i < files.length; i++) fd.append("files", files[i]);
      const res = await fetch("/api/assets/logos", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      return res.json();
    },
    onSuccess: () => {
      refetchLogos();
      toast({ title: "Added to library" });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Automated Shorts
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Full + short video per tab. Script and voiceover generated from short. BGM and logo shared.
        </p>
      </div>

      <Card className="p-6 space-y-5">
        <h2 className="font-semibold">Shared</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Background Music *</label>
            <div className="flex gap-2">
              <Select
                value={bgMusic ? "" : (bgMusicAssetId ?? "")}
                onValueChange={(v) => {
                  setBgMusic(null);
                  setBgMusicAssetId(v || undefined);
                }}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Saved tracks or upload" />
                </SelectTrigger>
                <SelectContent>
                  {bgMusicAssets.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = "audio/*";
                  input.onchange = (e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    if (f) { setBgMusic(f); setBgMusicAssetId(undefined); }
                  };
                  input.click();
                }}
              >
                {bgMusic ? "Change" : "Upload"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                title="Add to library"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = "audio/*";
                  input.multiple = true;
                  input.onchange = (e) => {
                    const files = (e.target as HTMLInputElement).files;
                    if (files?.length) addBgMusicMutation.mutate(files);
                  };
                  input.click();
                }}
              >
                <Library className="w-4 h-4" />
              </Button>
            </div>
            {bgMusic && <Badge variant="secondary" className="text-xs">{bgMusic.name}</Badge>}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Logo (optional)</label>
            <div className="flex gap-2">
              <Select
                value={logo ? "" : (logoAssetId ?? "")}
                onValueChange={(v) => {
                  setLogo(null);
                  setLogoAssetId(v || undefined);
                }}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Saved logos or upload" />
                </SelectTrigger>
                <SelectContent>
                  {logoAssets.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = "image/*";
                  input.onchange = (e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    if (f) { setLogo(f); setLogoAssetId(undefined); }
                  };
                  input.click();
                }}
              >
                {logo ? "Change" : "Upload"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                title="Add to library"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = "image/*";
                  input.multiple = true;
                  input.onchange = (e) => {
                    const files = (e.target as HTMLInputElement).files;
                    if (files?.length) addLogoMutation.mutate(files);
                  };
                  input.click();
                }}
              >
                <Library className="w-4 h-4" />
              </Button>
            </div>
            {logo && <Badge variant="secondary" className="text-xs">{logo.name}</Badge>}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Voice (ElevenLabs)</label>
          {voices.length === 0 ? (
            <p className="text-xs text-muted-foreground">Save ElevenLabs key in Settings first</p>
          ) : (
            <>
              <Select
                value={voiceId ?? voices[0]?.voice_id ?? ""}
                onValueChange={(v) => {
                  setVoiceId(v);
                  try {
                    localStorage.setItem(DEFAULT_VOICE_KEY, v);
                  } catch {}
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose voice" />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((v) => (
                    <SelectItem key={v.voice_id} value={v.voice_id}>
                      {v.name}
                      {v.category ? ` · ${v.category}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-1.5">
                {voices.map((v) => (
                  <Button
                    key={v.voice_id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={`h-8 gap-1 text-xs ${voiceId === v.voice_id ? "text-primary" : ""}`}
                    onClick={() => {
                      setVoiceId(v.voice_id);
                      try {
                        localStorage.setItem(DEFAULT_VOICE_KEY, v.voice_id);
                      } catch {}
                    }}
                  >
                    <Star className={`w-3.5 h-3.5 ${voiceId === v.voice_id ? "fill-amber-400 text-amber-500" : "text-muted-foreground"}`} />
                    {v.name}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Target duration</label>
          <div className="flex flex-wrap gap-2">
            {DURATION_OPTIONS.map((s) => (
              <Button
                key={s}
                type="button"
                variant={targetSeconds === s ? "default" : "outline"}
                size="sm"
                onClick={() => setTargetSeconds(s)}
              >
                {s}s
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Video type</label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={videoType === "edited" ? "default" : "outline"}
              size="sm"
              onClick={() => setVideoType("edited")}
            >
              Edited
            </Button>
            <Button
              type="button"
              variant={videoType === "raw" ? "default" : "outline"}
              size="sm"
              onClick={() => setVideoType("raw")}
            >
              Raw
            </Button>
          </div>
        </div>

        <CaptionStyleSelector selected={captionStyle} onSelect={setCaptionStyle} />
      </Card>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Tabs</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {tabs.length}/{AUTOMATED_SHORTS_MAX_TABS}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setBulkOpen(true)}
              className="gap-1"
              disabled={tabs.length >= AUTOMATED_SHORTS_MAX_TABS}
            >
              <ClipboardPaste className="w-4 h-4" />
              Bulk Paste
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addTab}
              className="gap-1"
              disabled={tabs.length >= AUTOMATED_SHORTS_MAX_TABS}
            >
              <Plus className="w-4 h-4" />
              Add tab
            </Button>
          </div>
        </div>

        <BulkPasteDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          onImport={handleBulkImport}
          maxRows={AUTOMATED_SHORTS_MAX_TABS - tabs.length}
          logoAssets={logoAssets}
        />

        {tabs.map((tab, i) => (
          <Card key={i} className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Tab {i + 1}</span>
              {tabs.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => removeTab(i)}
                >
                  Remove
                </Button>
              )}
            </div>
            
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2 flex-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Project Name (optional)
                </label>
                <Input
                  placeholder={`e.g. My Viral Short ${i + 1}`}
                  value={tab.projectName}
                  onChange={(e) => updateTab(i, { projectName: e.target.value })}
                  className="w-full max-w-sm"
                />
              </div>

              <div className="flex flex-col gap-3 mt-4 sm:mt-0 pt-2 border rounded-md p-3 max-w-sm">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`isVertical-${i}`}
                    checked={tab.isVerticalSource}
                    onChange={(e) => updateTab(i, { isVerticalSource: e.target.checked })}
                    className="rounded border-gray-300 text-primary focus:ring-primary w-4 h-4"
                  />
                  <label htmlFor={`isVertical-${i}`} className="text-sm cursor-pointer select-none">
                    Video is already 9:16 (skip blur)
                  </label>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground block">
                    Auto-Crop Vertical Video
                  </label>
                  <Select value={tab.cropType} onValueChange={(val) => updateTab(i, { cropType: val })}>
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue placeholder="Crop Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="16:9">Horizontal (16:9)</SelectItem>
                      <SelectItem value="1:1">Square (1:1)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id={`hookEnabled-${i}`}
                    checked={tab.hookEnabled}
                    onChange={(e) => updateTab(i, { hookEnabled: e.target.checked })}
                    className="rounded border-gray-300 text-primary focus:ring-primary w-4 h-4"
                  />
                  <label htmlFor={`hookEnabled-${i}`} className="text-sm cursor-pointer select-none">
                    AI Hook Intro
                  </label>
                  <span className="text-xs text-muted-foreground">
                    (3-13s engaging clip at the start)
                  </span>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id={`twoTakes-${i}`}
                    checked={tab.twoTakes}
                    onChange={(e) => updateTab(i, { twoTakes: e.target.checked })}
                    className="rounded border-gray-300 text-primary focus:ring-primary w-4 h-4"
                  />
                  <label htmlFor={`twoTakes-${i}`} className="text-sm cursor-pointer select-none">
                    Make 2 unique shorts from this source
                  </label>
                  <span className="text-xs text-muted-foreground">
                    (different voiceover & different highlights)
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Full video (URL or file)
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="https://..."
                    value={tab.fullVideoUrl}
                    onChange={(e) => updateTab(i, { fullVideoUrl: e.target.value })}
                    className="flex-1"
                  />
                  <FileInput
                    accept="video/*"
                    file={tab.fullVideoFile}
                    onSelect={(f) => updateTab(i, { fullVideoFile: f })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Short video (URL or file) *
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="https://... or upload file"
                    value={tab.shortVideoUrl}
                    onChange={(e) => updateTab(i, { shortVideoUrl: e.target.value })}
                    className="flex-1"
                  />
                  <FileInput
                    accept="video/*"
                    file={tab.shortVideoFile}
                    onSelect={(f) => updateTab(i, { shortVideoFile: f })}
                  />
                </div>
              </div>
            </div>
          </Card>
        ))}

        <Button
          className="gap-2"
          onClick={() => runMutation.mutate()}
          disabled={!canRun}
        >
          {runMutation.isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Run All
            </>
          )}
        </Button>
      </div>
      
      <div className="mt-12 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Processing Pipeline</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Track the progress of your batch jobs
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2 text-xs font-medium"
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: ["/api/projects"] })
            }
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <Card key={i} className="p-5">
                <div className="animate-pulse space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-muted" />
                    <div className="space-y-2 flex-1">
                      <div className="h-4 bg-muted rounded w-1/3" />
                      <div className="h-3 bg-muted rounded w-1/4" />
                    </div>
                  </div>
                  <div className="h-2 bg-muted rounded" />
                </div>
              </Card>
            ))}
          </div>
        ) : projects.filter(p => p.projectType === PROJECT_TYPES.AUTOMATED).length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16"
          >
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
              <Film className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-muted-foreground">
              No recent automated shorts
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Start a new batch to see processing progress here
            </p>
          </motion.div>
        ) : (
          <AnimatePresence mode="popLayout">
            <div className="space-y-4">
              {projects.filter(p => p.projectType === PROJECT_TYPES.AUTOMATED).map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onDelete={(id: number) => deleteMutation.mutate(id)}
                  onRetry={(id: number) => retryMutation.mutate(id)}
                />
              ))}
            </div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function FileInput({
  accept,
  file,
  onSelect,
}: {
  accept: string;
  file: File | null;
  onSelect: (f: File | null) => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.onchange = (e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          onSelect(f || null);
        };
        input.click();
      }}
    >
      {file ? file.name.slice(0, 12) + "…" : "Upload"}
    </Button>
  );
}

type BulkRow = {
  fullUrl: string;
  name: string;
  shortUrl: string;
  vertical: boolean;
  hook: boolean;
  twoTakes: boolean;
  /** Per-row logo override applied to Take 2 only. null = use global logo. */
  take2LogoAssetId: number | null;
  /** Logo overlay corner for Take 2. Default top-right. */
  take2LogoPosition: "top-right" | "top-left";
};

const EMPTY_ROW = (): BulkRow => ({
  fullUrl: "",
  name: "",
  shortUrl: "",
  vertical: false,
  hook: false,
  twoTakes: false,
  take2LogoAssetId: null,
  take2LogoPosition: "top-right",
});
const INITIAL_ROWS = 5;

function isTruthy(v: string): boolean {
  const l = v.trim().toLowerCase();
  return l === "yes" || l === "da" || l === "1" || l === "true";
}

function BulkPasteDialog({
  open,
  onOpenChange,
  onImport,
  maxRows,
  logoAssets,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImport: (rows: BulkRow[]) => void;
  maxRows: number;
  logoAssets: LogoAsset[];
}) {
  const [rows, setRows] = useState<BulkRow[]>(() =>
    Array.from({ length: INITIAL_ROWS }, EMPTY_ROW)
  );
  const { toast } = useToast();

  // Reset rows each time dialog opens
  useEffect(() => {
    if (open) {
      setRows(Array.from({ length: INITIAL_ROWS }, EMPTY_ROW));
    }
  }, [open]);

  const updateRow = (i: number, field: keyof BulkRow, value: string | boolean | number | null) => {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value };
      return next;
    });
  };

  // Handle paste from Google Sheets / Excel into any text cell
  const handleCellPaste = (
    e: React.ClipboardEvent<HTMLInputElement>,
    startRow: number,
    startCol: number
  ) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return; // single cell, let browser handle

    e.preventDefault();
    // Parse raw lines without header detection so pasting from mid-sheet works
    const lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length) return;

    // Columns in grid order: 0=fullUrl, 1=name, 2=shortUrl, 3=vertical, 4=hook, 5=twoTakes
    const colKeys: Array<keyof BulkRow> = ["fullUrl", "name", "shortUrl", "vertical", "hook", "twoTakes"];

    setRows((prev) => {
      const next = [...prev];
      lines.forEach((line, pi) => {
        const ri = startRow + pi;
        while (next.length <= ri && next.length < maxRows) {
          next.push(EMPTY_ROW());
        }
        if (ri >= maxRows) return;

        const parts = line.split("\t");
        const existing: BulkRow = next[ri] ? { ...next[ri] } : EMPTY_ROW();

        parts.forEach((val, ci) => {
          const colIdx = startCol + ci;
          if (colIdx >= colKeys.length) return;
          const key = colKeys[colIdx];
          if (key === "vertical" || key === "hook" || key === "twoTakes") {
            existing[key] = isTruthy(val);
          } else if (key === "take2LogoAssetId" || key === "take2LogoPosition") {
            // Per-row Take 2 settings are picked from dropdowns, not pasted
            return;
          } else {
            existing[key] = val.trim();
          }
        });

        next[ri] = existing;
      });
      return next;
    });
  };

  const addRows = () => {
    setRows((prev) => {
      const toAdd = Math.min(5, maxRows - prev.length);
      if (toAdd <= 0) return prev;
      return [...prev, ...Array.from({ length: toAdd }, EMPTY_ROW)];
    });
  };

  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, j) => j !== i));
  };

  const filledRows = rows.filter((r) => r.fullUrl || r.shortUrl);
  const fallbackRows = filledRows.filter((r) => !r.fullUrl || !r.shortUrl);

  const handleImport = () => {
    if (filledRows.length === 0) {
      toast({
        title: "No data",
        description: "Fill in at least one row with a URL.",
        variant: "destructive",
      });
      return;
    }
    onImport(filledRows);
    setRows(Array.from({ length: INITIAL_ROWS }, EMPTY_ROW));
  };

  const inputCls =
    "h-8 w-full border-0 rounded-none bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPaste className="w-5 h-5" />
            Bulk Paste from Spreadsheet
          </DialogTitle>
          <DialogDescription>
            Type or paste directly from Google Sheets / Excel.
            Column order:{" "}
            <code className="px-1 py-0.5 bg-muted rounded text-xs">
              Full URL → Name → Short URL → Vertical → Hook → 2x
            </code>
            <span className="block mt-1 text-xs text-muted-foreground">
              <strong>2x</strong> = make 2 unique shorts from this source
              (Take 2 uses a different voiceover, different highlights, and the{" "}
              <code className="px-1 py-0.5 bg-muted rounded">neon_pop</code> caption style).
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="border rounded-md overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-muted">
                    <th className="w-8 px-2 py-2 text-center text-xs font-medium text-muted-foreground border-r border-border">#</th>
                    <th className="px-2 py-2 text-left text-xs font-medium border-r border-border min-w-[200px]">Full Video URL</th>
                    <th className="px-2 py-2 text-left text-xs font-medium border-r border-border w-[140px]">Name</th>
                    <th className="px-2 py-2 text-left text-xs font-medium border-r border-border min-w-[200px]">Short Video URL</th>
                    <th className="w-12 px-2 py-2 text-center text-xs font-medium border-r border-border" title="Video is already 9:16">V</th>
                    <th className="w-12 px-2 py-2 text-center text-xs font-medium border-r border-border" title="AI Hook Intro">H</th>
                    <th className="w-12 px-2 py-2 text-center text-xs font-medium border-r border-border" title="Make 2 unique shorts (Take 2 uses neon_pop)">2x</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const hasFull = !!row.fullUrl;
                    const hasShort = !!row.shortUrl;
                    const isFallback = (hasFull || hasShort) && (!hasFull || !hasShort);
                    return (
                      <Fragment key={i}>
                      <tr className={`border-t border-border group ${isFallback ? "bg-amber-50/40" : ""}`}>
                        <td className="w-8 text-center text-xs text-muted-foreground border-r border-border select-none py-0">
                          {i + 1}
                        </td>
                        <td className="border-r border-border p-0">
                          <input
                            className={inputCls}
                            value={row.fullUrl}
                            placeholder="https://..."
                            onChange={(e) => updateRow(i, "fullUrl", e.target.value)}
                            onPaste={(e) => handleCellPaste(e, i, 0)}
                          />
                        </td>
                        <td className="border-r border-border p-0">
                          <input
                            className={inputCls}
                            value={row.name}
                            placeholder="My Video"
                            onChange={(e) => updateRow(i, "name", e.target.value)}
                            onPaste={(e) => handleCellPaste(e, i, 1)}
                          />
                        </td>
                        <td className="border-r border-border p-0">
                          <input
                            className={inputCls}
                            value={row.shortUrl}
                            placeholder="https://..."
                            onChange={(e) => updateRow(i, "shortUrl", e.target.value)}
                            onPaste={(e) => handleCellPaste(e, i, 2)}
                          />
                        </td>
                        <td className="w-12 border-r border-border text-center py-0">
                          <input
                            type="checkbox"
                            checked={row.vertical}
                            onChange={(e) => updateRow(i, "vertical", e.target.checked)}
                            className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer"
                          />
                        </td>
                        <td className="w-12 border-r border-border text-center py-0">
                          <input
                            type="checkbox"
                            checked={row.hook}
                            onChange={(e) => updateRow(i, "hook", e.target.checked)}
                            className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer"
                          />
                        </td>
                        <td className="w-12 border-r border-border text-center py-0">
                          <input
                            type="checkbox"
                            checked={row.twoTakes}
                            onChange={(e) => updateRow(i, "twoTakes", e.target.checked)}
                            className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer"
                            title="Make 2 unique shorts from this source"
                          />
                        </td>
                        <td className="w-8 text-center py-0">
                          <button
                            type="button"
                            onClick={() => removeRow(i)}
                            className="w-full h-8 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity text-xs"
                            title="Remove row"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                      {row.twoTakes && (
                        <tr className="border-t border-border bg-primary/5">
                          <td className="border-r border-border" />
                          <td colSpan={6} className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                              <span className="text-muted-foreground whitespace-nowrap">
                                Take 2 logo:
                              </span>
                              <select
                                value={row.take2LogoAssetId ?? ""}
                                onChange={(e) =>
                                  updateRow(
                                    i,
                                    "take2LogoAssetId",
                                    e.target.value === "" ? null : Number(e.target.value)
                                  )
                                }
                                className="h-7 rounded border border-input bg-background px-2 text-xs flex-1 min-w-[160px] max-w-xs"
                              >
                                <option value="">— Use the global logo —</option>
                                {logoAssets.map((l) => (
                                  <option key={l.id} value={l.id}>
                                    {l.name}
                                  </option>
                                ))}
                              </select>
                              <span className="text-muted-foreground whitespace-nowrap">
                                position:
                              </span>
                              <select
                                value={row.take2LogoPosition}
                                onChange={(e) =>
                                  updateRow(
                                    i,
                                    "take2LogoPosition",
                                    e.target.value as "top-right" | "top-left"
                                  )
                                }
                                className="h-7 rounded border border-input bg-background px-2 text-xs"
                              >
                                <option value="top-right">↗ Top-right</option>
                                <option value="top-left">↖ Top-left</option>
                              </select>
                              {logoAssets.length === 0 && (
                                <span className="text-muted-foreground italic">
                                  (no logos in library — upload one in the main page first)
                                </span>
                              )}
                            </div>
                          </td>
                          <td />
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addRows}
              disabled={rows.length >= maxRows}
              className="gap-1 text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              Add 5 rows
            </Button>

            {fallbackRows.length > 0 && (
              <span className="text-xs text-amber-600 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                {fallbackRows.length} row{fallbackRows.length !== 1 ? "s" : ""} with one URL — the other will be copied
              </span>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={filledRows.length === 0}
            className="gap-1"
          >
            <Plus className="w-4 h-4" />
            Import {filledRows.length > 0 ? filledRows.length : ""} Tab
            {filledRows.length !== 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
