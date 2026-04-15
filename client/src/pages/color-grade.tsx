import { useState } from "react";
import { motion } from "framer-motion";
import { Palette, Video, Loader2, Play } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Project } from "@shared/schema";
import { ProjectCard } from "@/components/ProjectCard";
import { AnimatePresence } from "framer-motion";

export default function ColorGrade() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState("");
  const [sourceVideo, setSourceVideo] = useState<File | null>(null);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append("sourceVideo", sourceVideo!);
      if (projectName) formData.append("name", projectName);

      const res = await fetch("/api/projects/color", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setSourceVideo(null);
      setProjectName("");
      toast({ title: "Pipeline started", description: "Color grading processing in background" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const { data: allProjects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });
  const projects = allProjects.filter(p => p.projectType === "color");

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
  });

  const canSubmit = sourceVideo && !uploadMutation.isPending;

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">AI Color Grading</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Automatically balance exposure and apply a professional cinematic color grade to your raw videos.
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
                placeholder="Cinematic Output"
                className="max-w-md"
              />
            </div>

            <div className="border-2 border-dashed rounded-xl p-6 flex flex-col items-center max-w-md">
              <Video className="w-8 h-8 mb-3 text-muted-foreground" />
              <span className="text-sm font-medium mb-2">Raw Source Video</span>
              <input type="file" accept="video/*" onChange={e => setSourceVideo(e.target.files?.[0] || null)} className="text-xs" />
            </div>

            <Button onClick={() => uploadMutation.mutate()} disabled={!canSubmit} className="w-full sm:w-auto">
              {uploadMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              Apply Color Grade
            </Button>
          </div>
        </Card>
      </motion.div>

      {projects.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Your Colored Videos</h2>
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
