import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Trash2, AlertTriangle, HardDrive } from "lucide-react";

type CleanupResponse = {
  success: boolean;
  freedBytes: number;
  freedMB: number;
};

export function CleanupSettingsCard() {
  const { toast } = useToast();
  const [showConfirm, setShowConfirm] = useState(false);

  const cleanupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/cleanup");
      return res.json() as Promise<CleanupResponse>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets/bg-music"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets/logos"] });
      toast({
        title: "Cleanup complete ✅",
        description: `Freed ${data.freedMB > 0 ? data.freedMB + " MB" : "< 1 MB"} of space. All projects, uploads, and cache cleared.`,
      });
      setShowConfirm(false);
    },
    onError: (err: Error) => {
      toast({
        title: "Cleanup failed",
        description: err.message,
        variant: "destructive",
      });
      setShowConfirm(false);
    },
  });

  return (
    <Card className="p-4 space-y-3 border-destructive/30">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
          <HardDrive className="w-4 h-4 text-destructive" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Storage Cleanup</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Delete all uploaded videos, audio files, generated outputs, and cached frames.
            Saved assets (bg music & logos) will be preserved. All project records will be removed from the database.
          </p>
        </div>
      </div>

      {!showConfirm ? (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="w-full"
          onClick={() => setShowConfirm(true)}
        >
          <Trash2 className="w-4 h-4 mr-2" />
          Clear All Files & Cache
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-3 py-2 bg-destructive/10 rounded-md">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
            <p className="text-xs text-destructive font-medium">
              This will permanently delete ALL uploads, outputs, downloads, and project records. Saved assets (bg music & logos) will NOT be deleted. This action cannot be undone.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setShowConfirm(false)}
              disabled={cleanupMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="flex-1"
              disabled={cleanupMutation.isPending}
              onClick={() => cleanupMutation.mutate()}
            >
              {cleanupMutation.isPending ? "Cleaning..." : "Yes, Delete Everything"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
