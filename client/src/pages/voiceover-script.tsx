import { useState, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Video, Loader2, Sparkles, CheckCircle2, Copy, Mic2, Film, Scissors } from "lucide-react";

const DURATION_OPTIONS = [8, 10, 15, 20, 25, 30, 45, 60] as const;

type VideoType = "edited" | "raw";

export default function VoiceoverScriptPage() {
  const { toast } = useToast();
  const [video, setVideo] = useState<File | null>(null);
  const [videoType, setVideoType] = useState<VideoType>("raw");
  const [targetSeconds, setTargetSeconds] = useState<number>(20);
  const [script, setScript] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("video/")) setVideo(f);
  }, []);

  const handleGenerate = async (includeAudio = false) => {
    if (!video) return;
    try {
      setIsGenerating(true);
      setScript("");
      setAudioUrl(null);
      const formData = new FormData();
      formData.append("video", video);
      formData.append("targetSeconds", String(targetSeconds));
      formData.append("videoType", videoType);
      const url = includeAudio
        ? "/api/voiceover-script?generateAudio=true"
        : "/api/voiceover-script";
      const res = await fetch(url, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || res.statusText);
      }
      const json = (await res.json()) as { script?: string; audioUrl?: string };
      if (!json.script) throw new Error("No script returned");
      setScript(json.script);
      if (json.audioUrl) setAudioUrl(json.audioUrl);
      toast({
        title: "Script generated",
        description: "Your viral voiceover script is ready.",
      });
    } catch (err: any) {
      toast({
        title: "Generation failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = () => {
    if (!script) return;
    navigator.clipboard.writeText(script);
    toast({ title: "Copied to clipboard" });
  };

  return (
    <div className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Viral Voiceover Script
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload video. Edited clips get improved voiceover; raw footage gets a full viral script. CTA to full video at the end.
          </p>
        </div>
      </div>

      <Card className="p-6 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Video (max 20MB)</label>
          <div
            className={`rounded-xl border-2 border-dashed transition-all cursor-pointer ${
              isDragOver ? "border-primary bg-primary/5" : video ? "border-emerald-500/50 bg-emerald-500/5" : "border-border hover:border-primary/40"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "video/*";
              input.onchange = (e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) setVideo(f);
              };
              input.click();
            }}
          >
            <div className="flex flex-col items-center justify-center p-6 gap-3">
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                  video ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground"
                }`}
              >
                {video ? <CheckCircle2 className="w-6 h-6" /> : <Video className="w-6 h-6" />}
              </div>
              <p className="text-sm font-medium">
                {video ? video.name : "Drop video or click to browse"}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Video type</label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={videoType === "edited" ? "default" : "outline"}
              size="sm"
              className="gap-1.5"
              onClick={() => setVideoType("edited")}
            >
              <Scissors className="w-3.5 h-3.5" />
              Edited video
            </Button>
            <Button
              type="button"
              variant={videoType === "raw" ? "default" : "outline"}
              size="sm"
              className="gap-1.5"
              onClick={() => setVideoType("raw")}
            >
              <Film className="w-3.5 h-3.5" />
              Raw footage
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {videoType === "edited"
              ? "Short clip with existing voiceover — improve and vary it"
              : "Longer clip, no editing — create full viral voiceover"}
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Target duration (seconds)</label>
          <div className="flex flex-wrap gap-2">
            {DURATION_OPTIONS.map((sec) => (
              <Button
                key={sec}
                type="button"
                variant={targetSeconds === sec ? "default" : "outline"}
                size="sm"
                onClick={() => setTargetSeconds(sec)}
              >
                {sec}s
              </Button>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            className="gap-2"
            onClick={() => handleGenerate(false)}
            disabled={!video || isGenerating}
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Generate script
              </>
            )}
          </Button>
          <Button
            variant="secondary"
            className="gap-2"
            onClick={() => handleGenerate(true)}
            disabled={!video || isGenerating}
          >
            {isGenerating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <Mic2 className="w-4 h-4" />
                Generate script + audio
              </>
            )}
          </Button>
        </div>

        {script && (
          <div className="space-y-2 pt-4 border-t">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Generated script</label>
              <Button variant="ghost" size="sm" onClick={handleCopy} className="gap-1">
                <Copy className="w-3.5 h-3.5" />
                Copy
              </Button>
            </div>
            <Textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              className="min-h-[160px] font-mono text-sm"
            />
            {audioUrl && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Audio</p>
                <audio controls src={audioUrl} className="w-full" />
                <a
                  href={audioUrl}
                  download
                  className="inline-flex items-center gap-1.5 text-xs text-primary underline"
                >
                  Download MP3
                </a>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
