import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Download, Link2, ListFilter, Loader2 } from "lucide-react";

type DownloaderFormat = {
  id: string;
  label: string;
  ext: string;
  height?: number;
  fps?: number;
  isVideoOnly: boolean;
  isAudioOnly: boolean;
};

export default function DownloadPage() {
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [formats, setFormats] = useState<DownloaderFormat[]>([]);
  const [selectedFormatId, setSelectedFormatId] = useState<string | undefined>();
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loadingFormats, setLoadingFormats] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleGetFormats = async () => {
    try {
      setLoadingFormats(true);
      setFormats([]);
      setSelectedFormatId(undefined);
      setDownloadUrl(null);
      const res = await fetch("/api/downloader/formats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg);
      }
      const json = (await res.json()) as { formats?: DownloaderFormat[] };
      const list = json.formats ?? [];
      setFormats(list);
      if (list[0]) setSelectedFormatId(list[0].id);
      toast({
        title: "Formats loaded",
        description: `${list.length} options found for this URL.`,
      });
    } catch (err: any) {
      toast({
        title: "Failed to fetch formats",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoadingFormats(false);
    }
  };

  const handleDownload = async () => {
    const selected = formats.find((f) => f.id === selectedFormatId);
    try {
      setDownloading(true);
      setDownloadUrl(null);
      const res = await fetch("/api/downloader/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          formatId: selectedFormatId,
          isVideoOnly: selected?.isVideoOnly ?? false,
        }),
        credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg);
      }
      const json = (await res.json()) as { downloadUrl?: string };
      if (!json.downloadUrl) {
        throw new Error("No downloadUrl returned");
      }
      setDownloadUrl(json.downloadUrl);
      toast({
        title: "Download ready",
        description: "Click the link below to save the video.",
      });
    } catch (err: any) {
      toast({
        title: "Download failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Download className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Download video from URL</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Use yt-dlp under the hood to fetch videos from YouTube, Facebook, Instagram, TikTok and more.
          </p>
        </div>
      </div>

      <Card className="p-6 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium flex items-center gap-2">
            Video URL
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 flex items-center gap-2">
              <Link2 className="w-4 h-4 text-muted-foreground" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="flex-1"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={handleGetFormats}
              disabled={loadingFormats || !url.trim()}
            >
              {loadingFormats ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Getting formats...
                </>
              ) : (
                <>
                  <ListFilter className="w-4 h-4" />
                  Get qualities
                </>
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            If some sites are geo-blocked, you can configure <code>YT_DLP_PROXY</code> in your server&nbsp;.env.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Choose quality</label>
          {formats.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Load formats first, then pick the desired resolution.
            </p>
          ) : (
            <Select
              value={selectedFormatId}
              onValueChange={(val) => setSelectedFormatId(val)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select quality" />
              </SelectTrigger>
              <SelectContent>
                {formats.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.label} {f.ext ? `· ${f.ext}` : ""}{" "}
                    {f.isVideoOnly ? "(video-only)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <Button
          type="button"
          className="gap-2"
          disabled={
            downloading || !url.trim() || !selectedFormatId || formats.length === 0
          }
          onClick={handleDownload}
        >
          {downloading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Downloading...
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Download
            </>
          )}
        </Button>

        {downloadUrl && (
          <div className="pt-3">
            <a
              href={downloadUrl}
              download
              className="inline-flex items-center gap-1.5 text-xs text-primary underline underline-offset-4"
            >
              <Download className="w-3 h-3" />
              Save video file
            </a>
          </div>
        )}
      </Card>
    </div>
  );
}

