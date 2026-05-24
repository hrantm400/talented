import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Video,
  Mic,
  Play,
  CheckCircle2,
  Loader2,
  Upload,
  Sparkles,
  Film,
  RefreshCw,
  Library,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { motion, AnimatePresence } from "framer-motion";
import { CaptionStyleSelector } from "@/components/caption-styles";
import { PROJECT_TYPES, type Project } from "@shared/schema";
import { ProjectCard } from "@/components/ProjectCard";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

type BgMusicAsset = { id: number; name: string };
type LogoAsset = { id: number; name: string };

interface FileUploadZoneProps {
  label: string;
  accept: string;
  icon: typeof Video;
  file: File | null;
  onFileSelect: (file: File) => void;
  required?: boolean;
  description: string;
}

function FileUploadZone({
  label,
  accept,
  icon: Icon,
  file,
  onFileSelect,
  required = true,
  description,
}: FileUploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) onFileSelect(droppedFile);
    },
    [onFileSelect]
  );

  return (
    <div
      data-testid={`upload-zone-${label.toLowerCase().replace(/\s/g, "-")}`}
      className={`relative rounded-xl border-2 border-dashed transition-all duration-300 cursor-pointer group ${
        isDragOver
          ? "border-primary bg-primary/5 scale-[1.02]"
          : file
            ? "border-emerald-500/50 bg-emerald-500/5"
            : "border-border hover:border-primary/40 hover:bg-muted/30"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onClick={() => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.onchange = (e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) onFileSelect(f);
        };
        input.click();
      }}
    >
      <div className="flex flex-col items-center justify-center p-6 gap-3">
        <div
          className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
            file
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary"
          }`}
        >
          {file ? (
            <CheckCircle2 className="w-6 h-6" />
          ) : (
            <Icon className="w-6 h-6" />
          )}
        </div>
        <div className="text-center">
          <p className="font-semibold text-sm">
            {label}
            {required && <span className="text-destructive ml-1">*</span>}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        </div>
        {file ? (
          <Badge variant="secondary" className="text-xs max-w-full truncate">
            {file.name}
          </Badge>
        ) : (
          <p className="text-xs text-muted-foreground">
            Drop file or click to browse
          </p>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const { toast } = useToast();
  const [projectName, setProjectName] = useState("");
  const [sourceVideo, setSourceVideo] = useState<File | null>(null);
  const [voiceover, setVoiceover] = useState<File | null>(null);
  const [bgMusic, setBgMusic] = useState<File | null>(null);
  const [bgMusicAssetId, setBgMusicAssetId] = useState<string | undefined>();
  const [logo, setLogo] = useState<File | null>(null);
  const [logoAssetId, setLogoAssetId] = useState<string | undefined>();
  const [captionStyle, setCaptionStyle] = useState("capcut_green");
  const [isVerticalSource, setIsVerticalSource] = useState(false);
  const [cropType, setCropType] = useState("none");
  const [hookEnabled, setHookEnabled] = useState(false);

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });
  const { data: bgMusicAssets = [], refetch: refetchBgMusic } = useQuery<BgMusicAsset[]>({
    queryKey: ["/api/assets/bg-music"],
  });
  const { data: logoAssets = [], refetch: refetchLogos } = useQuery<LogoAsset[]>({
    queryKey: ["/api/assets/logos"],
  });

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

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append("sourceVideo", sourceVideo!);
      formData.append("voiceover", voiceover!);
      if (bgMusic) formData.append("bgMusic", bgMusic);
      if (bgMusicAssetId) formData.append("bgMusicAssetId", bgMusicAssetId);
      if (logo) formData.append("logo", logo);
      if (logoAssetId) formData.append("logoAssetId", logoAssetId);
      if (projectName) formData.append("name", projectName);
      formData.append("captionStyle", captionStyle);
      formData.append("isVerticalSource", String(isVerticalSource));
      formData.append("cropType", cropType);
      formData.append("hookEnabled", String(hookEnabled));

      const res = await fetch("/api/projects/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setSourceVideo(null);
      setVoiceover(null);
      setBgMusic(null);
      setBgMusicAssetId(undefined);
      setLogo(null);
      setLogoAssetId(undefined);
      setProjectName("");
      setCaptionStyle("capcut_green");
      setIsVerticalSource(false);
      setCropType("none");
      setHookEnabled(false);
      toast({ title: "Project created", description: "Pipeline processing has started" });
    },
    onError: (error: Error) => {
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
  });

  const canSubmit = sourceVideo && voiceover && (bgMusic || bgMusicAssetId) && !uploadMutation.isPending;

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Classic Auto-Shorts</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload horizontal videos to create 9:16 blurred background sandwich reels with AI subtitles.
        </p>
      </div>
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <Card className="overflow-hidden">
            <div className="bg-gradient-to-r from-primary/5 via-violet-500/5 to-primary/5 px-6 py-5 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Upload className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h2 className="font-semibold">Create New Short</h2>
                  <p className="text-sm text-muted-foreground">
                    Upload your files to start the automated pipeline
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-5">
              <div>
                <label className="text-sm font-medium mb-2 block">
                  Project Name
                </label>
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="My Awesome Short"
                  className="max-w-md"
                  data-testid="input-project-name"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <FileUploadZone
                  label="Source Video"
                  accept="video/*"
                  icon={Video}
                  file={sourceVideo}
                  onFileSelect={setSourceVideo}
                  description="Horizontal MP4 video"
                />
                <FileUploadZone
                  label="Voiceover"
                  accept="audio/*"
                  icon={Mic}
                  file={voiceover}
                  onFileSelect={setVoiceover}
                  description="MP3 narration track"
                />
                <div className="rounded-xl border-2 border-dashed border-border p-4 space-y-2">
                  <p className="font-semibold text-sm">
                    Background Music
                    <span className="text-destructive ml-1">*</span>
                  </p>
                  <p className="text-xs text-muted-foreground">Saved tracks or upload</p>
                  <div className="flex gap-2 flex-wrap">
                    <Select
                      value={bgMusic ? "" : (bgMusicAssetId ?? "")}
                      onValueChange={(v) => {
                        setBgMusic(null);
                        setBgMusicAssetId(v || undefined);
                      }}
                    >
                      <SelectTrigger className="flex-1 min-w-0">
                        <SelectValue placeholder="From library" />
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
                          if (f) {
                            setBgMusic(f);
                            setBgMusicAssetId(undefined);
                          }
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
                  {(bgMusic || bgMusicAssetId) && (
                    <Badge variant="secondary" className="text-xs">
                      {bgMusic ? bgMusic.name : bgMusicAssets.find((a) => String(a.id) === bgMusicAssetId)?.name ?? "From library"}
                    </Badge>
                  )}
                </div>
                <div className="rounded-xl border-2 border-dashed border-border p-4 space-y-2">
                  <p className="font-semibold text-sm">Logo</p>
                  <p className="text-xs text-muted-foreground">Saved logos or upload (optional)</p>
                  <div className="flex gap-2 flex-wrap">
                    <Select
                      value={logo ? "" : (logoAssetId ?? "")}
                      onValueChange={(v) => {
                        setLogo(null);
                        setLogoAssetId(v || undefined);
                      }}
                    >
                      <SelectTrigger className="flex-1 min-w-0">
                        <SelectValue placeholder="From library" />
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
                          if (f) {
                            setLogo(f);
                            setLogoAssetId(undefined);
                          }
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
                  {(logo || logoAssetId) && (
                    <Badge variant="secondary" className="text-xs">
                      {logo ? logo.name : logoAssets.find((a) => String(a.id) === logoAssetId)?.name ?? "From library"}
                    </Badge>
                  )}
                </div>
              </div>

              <CaptionStyleSelector
                selected={captionStyle}
                onSelect={setCaptionStyle}
              />

              <div className="space-y-4 pt-2 pb-2">
                <div className="flex items-center space-x-2">
                  <Switch 
                    id="vertical-source" 
                    checked={isVerticalSource} 
                    onCheckedChange={setIsVerticalSource} 
                  />
                  <Label htmlFor="vertical-source">Video is already 9:16 (skip background blur)</Label>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-medium">Auto-Crop 9:16 video formats</Label>
                  <Select value={cropType} onValueChange={setCropType}>
                    <SelectTrigger className="w-full sm:max-w-[300px]">
                      <SelectValue placeholder="Select crop type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (keep as is)</SelectItem>
                      <SelectItem value="16:9">Extract Horizontal Center (16:9)</SelectItem>
                      <SelectItem value="1:1">Extract Square Center (1:1)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Use this if your vertical video actually has a horizontal/square video inside with black bars on top and bottom.
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2 pt-1 pb-2">
                <Switch 
                  id="hook-enabled" 
                  checked={hookEnabled} 
                  onCheckedChange={setHookEnabled} 
                />
                <Label htmlFor="hook-enabled">AI Hook Intro</Label>
                <span className="text-xs text-muted-foreground ml-2">
                  AI finds the most engaging 3-13s moment and places it at the start
                </span>
              </div>

              <div className="flex items-center gap-4 pt-2">
                <Button
                  onClick={() => uploadMutation.mutate()}
                  disabled={!canSubmit}
                  className="gap-2 px-6"
                  data-testid="button-start-pipeline"
                >
                  {uploadMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Start Pipeline
                    </>
                  )}
                </Button>
                {!canSubmit && !uploadMutation.isPending && (
                  <p className="text-xs text-muted-foreground">
                    Upload source video, voiceover, and pick or upload background music to begin
                  </p>
                )}
              </div>
            </div>
          </Card>
        </motion.div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Projects</h2>
              {(() => {
                const classicCount = projects.filter(
                  (p) => p.projectType === PROJECT_TYPES.CLASSIC
                ).length;
                return classicCount > 0 ? (
                  <Badge variant="secondary" className="text-xs">
                    {classicCount}
                  </Badge>
                ) : null;
              })()}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: ["/api/projects"] })
              }
              data-testid="button-refresh"
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
          ) : projects.filter(p => p.projectType === PROJECT_TYPES.CLASSIC).length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center py-16"
            >
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
                <Film className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="font-semibold text-muted-foreground">
                No projects yet
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Upload your first video to create an AI-powered vertical short
              </p>
            </motion.div>
          ) : (
            <AnimatePresence mode="popLayout">
              <div className="space-y-4">
                {projects.filter(p => p.projectType === PROJECT_TYPES.CLASSIC).map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    onDelete={(id) => deleteMutation.mutate(id)}
                  />
                ))}
              </div>
            </AnimatePresence>
          )}
        </div>

        <Card className="p-6 bg-gradient-to-r from-primary/[0.03] to-violet-500/[0.03] border-primary/10">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-sm">How It Works</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
                {[
                  {
                    step: "1",
                    title: "AI finds best moments",
                    desc: "Gemini transcribes your voiceover and picks the coolest, most engaging segments from your video to match what you say",
                  },
                  {
                    step: "2",
                    title: "Smart composition",
                    desc: "9:16 vertical layout with blurred background and a large 1:1-style center video so the action stands out",
                  },
                  {
                    step: "3",
                    title: "Dual export",
                    desc: "Get two versions: a clean edit and one with animated subtitles and logo",
                  },
                ].map((item) => (
                  <div key={item.step} className="flex gap-3">
                    <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                      {item.step}
                    </div>
                    <div>
                      <p className="font-medium text-sm">{item.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
    </div>
  );
}
