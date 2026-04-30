import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Mic2, Loader2, Sparkles, Star, ExternalLink } from "lucide-react";
import { Link } from "wouter";

const DEFAULT_VOICE_STORAGE_KEY = "elevenlabs_default_voice_id";

type ElevenVoice = {
  voice_id: string;
  name: string;
  category?: string;
  preview_url?: string;
};

export default function ElevenLabsPage() {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | undefined>();
  const [defaultVoiceIdStored, setDefaultVoiceIdStored] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const { data: voicesData, isLoading: voicesLoading } = useQuery<{
    voices: ElevenVoice[];
  }>({
    queryKey: ["/api/elevenlabs/voices"],
  });

  const voices = voicesData?.voices ?? [];

  // Restore default voice from localStorage when voices load
  useEffect(() => {
    if (voices.length === 0) return;
    try {
      const stored = localStorage.getItem(DEFAULT_VOICE_STORAGE_KEY);
      setDefaultVoiceIdStored(stored);
      const found = stored && voices.find((v) => v.voice_id === stored);
      setSelectedVoiceId((prev) => {
        if (prev !== undefined) return prev;
        return found ? found.voice_id : voices[0].voice_id;
      });
    } catch {
      setSelectedVoiceId((prev) => prev ?? voices[0]?.voice_id);
    }
  }, [voices]);

  const setDefaultVoice = (voiceId: string) => {
    setSelectedVoiceId(voiceId);
    setDefaultVoiceIdStored(voiceId);
    try {
      localStorage.setItem(DEFAULT_VOICE_STORAGE_KEY, voiceId);
    } catch {
      /* ignore */
    }
    toast({
      title: "Default voice updated",
      description: "This voice will be used by default when you generate.",
    });
  };

  const handleGenerate = async () => {
    try {
      setIsGenerating(true);
      setAudioUrl(null);
      const res = await fetch("/api/elevenlabs/voiceover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceId: selectedVoiceId }),
        credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg);
      }
      const json = (await res.json()) as { audioUrl?: string };
      if (!json.audioUrl) {
        throw new Error("No audioUrl returned");
      }
      setAudioUrl(json.audioUrl);
      toast({
        title: "Voiceover generated",
        description: "ElevenLabs audio is ready.",
      });
    } catch (err: any) {
      toast({
        title: "Voiceover failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const defaultVoiceId = selectedVoiceId ?? voices[0]?.voice_id;

  return (
    <div className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Mic2 className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            ElevenLabs Voiceover
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Turn your script into speech. API keys and plan are stored in Postgres, not in
            the browser.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[2fr,1fr] gap-4 items-start">
        <Card className="p-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Script text</label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste or type the script you want to turn into voiceover..."
              className="min-h-[140px]"
            />
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium flex items-center gap-2">
                Voice
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Sparkles className="w-3 h-3" />
                  Loaded from ElevenLabs · click ★ to set default
                </span>
              </label>
              {voicesLoading ? (
                <p className="text-xs text-muted-foreground">Loading voices...</p>
              ) : voices.length === 0 ? (
                <p className="text-xs text-destructive">
                  No voices available. Save a valid ElevenLabs key in settings and check your
                  account limits.
                </p>
              ) : (
                <>
                  <Select
                    value={selectedVoiceId ?? defaultVoiceId ?? ""}
                    onValueChange={(value) => setSelectedVoiceId(value)}
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
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {voices.map((v) => {
                      const isDefault = defaultVoiceIdStored === v.voice_id;
                      return (
                        <Button
                          key={v.voice_id}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1 text-xs font-normal"
                          onClick={() => setDefaultVoice(v.voice_id)}
                          title={isDefault ? "Default voice" : "Set as default voice"}
                        >
                          <Star
                            className={`w-3.5 h-3.5 ${isDefault ? "fill-amber-400 text-amber-500" : "text-muted-foreground"}`}
                          />
                          {v.name}
                        </Button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <Button
              className="w-full gap-2 mt-2"
              onClick={handleGenerate}
              disabled={isGenerating || !text.trim() || voices.length === 0}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Mic2 className="w-4 h-4" />
                  Generate voiceover
                </>
              )}
            </Button>

            {audioUrl && (
              <div className="space-y-2 mt-4">
                <p className="text-xs font-medium text-muted-foreground">Preview</p>
                <audio controls src={audioUrl} className="w-full" />
                <a
                  href={audioUrl}
                  download
                  className="inline-flex items-center gap-1.5 text-xs text-primary underline underline-offset-4"
                >
                  Download MP3
                </a>
              </div>
            )}
          </div>
        </Card>

        <Card className="p-6 bg-muted/30 border-dashed">
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-2">
            <Mic2 className="w-4 h-4 text-primary" />
            API Keys & Plans
          </h2>
          <p className="text-xs text-muted-foreground mb-4">
            ElevenLabs keys and default models are now managed in your personal or admin settings. 
            You can configure multiple keys and seamlessly switch between them.
          </p>
          <Link href="/settings">
            <Button variant="outline" size="sm" className="w-full gap-2">
              <ExternalLink className="w-4 h-4" />
              Manage API Keys
            </Button>
          </Link>
        </Card>
      </div>
    </div>
  );
}


