import { useState } from "react";
import { motion } from "framer-motion";
import { Mic2, Music, Upload, Loader2, Play } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

import { useQuery } from "@tanstack/react-query";
import { PROJECT_TYPES } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import type { Project } from "@shared/schema";
import { ProjectCard } from "@/components/ProjectCard";
import { AnimatePresence } from "framer-motion";

export default function AutoDucking() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState("");
  const [voiceover, setVoiceover] = useState<File | null>(null);
  const [bgMusic, setBgMusic] = useState<File | null>(null);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append("voiceover", voiceover!);
      formData.append("bgMusic", bgMusic!);
      if (projectName) formData.append("name", projectName);

      const res = await fetch("/api/projects/ducking", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setVoiceover(null);
      setBgMusic(null);
      setProjectName("");
      toast({ title: "Pipeline started", description: "Auto-ducking processing in background" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const { data: allProjects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });
  const projects = allProjects.filter(p => p.projectType === PROJECT_TYPES.DUCKING);

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
  });

  const canSubmit = voiceover && bgMusic && !uploadMutation.isPending;

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Auto-Ducking</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Smart audio engineering that automatically lowers background music when a voice is speaking.
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
                placeholder="My Ducked Audio"
                className="max-w-md"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border-2 border-dashed rounded-xl p-6 flex flex-col items-center">
                <Mic2 className="w-8 h-8 mb-3 text-muted-foreground" />
                <span className="text-sm font-medium mb-2">Voiceover Track</span>
                <input type="file" accept="audio/*" onChange={e => setVoiceover(e.target.files?.[0] || null)} className="text-xs" />
              </div>

              <div className="border-2 border-dashed rounded-xl p-6 flex flex-col items-center">
                <Music className="w-8 h-8 mb-3 text-muted-foreground" />
                <span className="text-sm font-medium mb-2">Background Music</span>
                <input type="file" accept="audio/*" onChange={e => setBgMusic(e.target.files?.[0] || null)} className="text-xs" />
              </div>
            </div>

            <Button onClick={() => uploadMutation.mutate()} disabled={!canSubmit} className="w-full sm:w-auto">
              {uploadMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              Start Ducking
            </Button>
          </div>
        </Card>
      </motion.div>

      {projects.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Your Ducked Audios</h2>
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
