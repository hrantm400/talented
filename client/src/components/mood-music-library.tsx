import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Music, Trash2, Upload } from "lucide-react";

type Track = { id: number; name: string; filePath: string; mood: string | null };

// Must match MOOD_TAGS the AI classifies videos into (server/pipeline/gemini.ts).
const MOODS = ["epic", "emotional", "uplifting", "dramatic", "energetic", "happy", "chill", "dark"];

export function MoodMusicLibrary() {
  const { toast } = useToast();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [uploadMood, setUploadMood] = useState("epic");
  const [uploading, setUploading] = useState(false);

  const load = () =>
    fetch("/api/assets/bg-music", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setTracks(Array.isArray(d) ? d : []))
      .catch(() => {});
  useEffect(() => { load(); }, []);

  const upload = (files: FileList) => {
    setUploading(true);
    const fd = new FormData();
    for (let i = 0; i < files.length; i++) fd.append("files", files[i]);
    fd.append("mood", uploadMood);
    fetch("/api/assets/bg-music", { method: "POST", body: fd, credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error("Upload failed"); return r.json(); })
      .then(() => { toast({ title: "Uploaded", description: `Added to “${uploadMood}”` }); load(); })
      .catch((e) => toast({ title: "Failed", description: e.message, variant: "destructive" }))
      .finally(() => setUploading(false));
  };

  const setMood = (id: number, mood: string) => {
    fetch(`/api/assets/bg-music/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ mood }),
    })
      .then(() => setTracks((t) => t.map((x) => (x.id === id ? { ...x, mood: mood || null } : x))))
      .catch(() => {});
  };

  const del = (id: number) => {
    fetch(`/api/assets/bg-music/${id}`, { method: "DELETE", credentials: "include" })
      .then(() => setTracks((t) => t.filter((x) => x.id !== id)))
      .catch(() => {});
  };

  const byMood = (m: string) => tracks.filter((t) => t.mood === m).length;

  return (
    <div className="bg-card border border-border rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Music className="w-5 h-5 text-violet-500" />
        <h3 className="font-semibold text-lg">Mood Music Library</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Upload your OWN tracks tagged by mood. The Factory's AI detects each video's mood and drops in a matching
        track at random — no external API, copyright-safe. (Untagged tracks are used as a fallback for any mood.)
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Upload to mood:</span>
        <select value={uploadMood} onChange={(e) => setUploadMood(e.target.value)} className="h-9 rounded border border-input bg-background px-2 text-sm">
          {MOODS.map((m) => <option key={m} value={m}>{m} ({byMood(m)})</option>)}
        </select>
        <Button type="button" variant="outline" size="sm" className="gap-1" disabled={uploading} onClick={() => {
          const input = document.createElement("input"); input.type = "file"; input.accept = "audio/*"; input.multiple = true;
          input.onchange = (e) => { const f = (e.target as HTMLInputElement).files; if (f?.length) upload(f); }; input.click();
        }}>
          <Upload className="w-4 h-4" />{uploading ? "Uploading…" : `Upload track(s)`}
        </Button>
      </div>

      <div className="space-y-1">
        {tracks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tracks yet — upload some music above.</p>
        ) : (
          tracks.map((t) => (
            <div key={t.id} className="flex items-center gap-2 p-2 rounded border border-border bg-muted/20 text-xs">
              <Music className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 truncate" title={t.name}>{t.name}</span>
              <select value={t.mood || ""} onChange={(e) => setMood(t.id, e.target.value)} className="h-7 rounded border border-input bg-background px-1">
                <option value="">untagged</option>
                {MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button type="button" onClick={() => del(t.id)} className="text-muted-foreground hover:text-destructive shrink-0">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
