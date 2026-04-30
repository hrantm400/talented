import { useState } from "react";
import { motion } from "framer-motion";
import { Mic, Loader2, Play } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PROJECT_TYPES, type Project } from "@shared/schema";
import { ProjectCard } from "@/components/ProjectCard";
import { AnimatePresence } from "framer-motion";

export default function VocalIsolator() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState("");
  const [sourceMedia, setSourceMedia] = useState<File | null>(null);
  const [mode, setMode] = useState<"vocals" | "instrumental">("vocals");

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append("sourceMedia", sourceMedia!);
      formData.append("mode", mode);
      if (projectName) formData.append("name", projectName);

      const res = await fetch("/api/projects/isolate", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setSourceMedia(null);
      setProjectName("");
      toast({
        title: "Pipeline started",
        description: "Demucs source separation runs on CPU — expect ~5–10× the source duration.",
      });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const { data: allProjects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });
  const projects = allProjects.filter(p => p.projectType === PROJECT_TYPES.ISOLATE);

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
  });

  const canSubmit = sourceMedia && !uploadMutation.isPending;

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Vocal Isolator</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Real source separation with Demucs (htdemucs). Splits any track into a clean vocal stem and an
          instrumental stem. CPU-only here — processing takes about 5–10× the source duration.
        </p>
      </div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="p-6">
          <div className="space-y-6">
            <div>
              <label className="text-sm font-medium mb-2 block">Project Name</label>
              <Input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Cleaned Audio/Video"
                className="max-w-md"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Output Stem</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl">
                <button
                  type="button"
                  onClick={() => setMode("vocals")}
                  className={`text-left rounded-lg border p-3 transition-all ${
                    mode === "vocals"
                      ? "border-primary bg-primary/5 shadow-sm"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <div className="font-medium text-sm">🎤 Vocals only</div>
                  <div className="text-xs text-muted-foreground mt-1">Acapella — voice with the music removed.</div>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("instrumental")}
                  className={`text-left rounded-lg border p-3 transition-all ${
                    mode === "instrumental"
                      ? "border-primary bg-primary/5 shadow-sm"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <div className="font-medium text-sm">🎹 Instrumental</div>
                  <div className="text-xs text-muted-foreground mt-1">Karaoke — music with the vocals removed.</div>
                </button>
              </div>
            </div>

            <div className="border-2 border-dashed rounded-xl p-6 flex flex-col items-center max-w-md">
              <div className="flex gap-2 mb-3 text-muted-foreground">
                <Mic className="w-8 h-8" />
              </div>
              <span className="text-sm font-medium mb-2">Video or Audio Source</span>
              <p className="text-[10px] text-muted-foreground text-center mb-4 max-w-[220px]">
                Upload an MP4 video or an MP3/WAV file. Demucs separates voice from music.
              </p>
              <input type="file" accept="video/*,audio/*" onChange={e => setSourceMedia(e.target.files?.[0] || null)} className="text-xs" />
            </div>

            <Button onClick={() => uploadMutation.mutate()} disabled={!canSubmit} className="w-full sm:w-auto">
              {uploadMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              Run Source Separation
            </Button>
          </div>
        </Card>
      </motion.div>

      {projects.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Your Cleaned Media</h2>
          <AnimatePresence mode="popLayout">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onDelete={(id) => deleteMutation.mutate(id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
