import { useState } from "react";
import { motion } from "framer-motion";
import { Film, Video, Loader2, Play } from "lucide-react";
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

export default function MotionTrack() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [projectName, setProjectName] = useState("");
  const [overlayText, setOverlayText] = useState("Awesome!");
  const [sourceVideo, setSourceVideo] = useState<File | null>(null);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      formData.append("sourceVideo", sourceVideo!);
      if (projectName) formData.append("name", projectName);
      if (overlayText) formData.append("overlayText", overlayText);

      const res = await fetch("/api/projects/motion-track", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setSourceVideo(null);
      setProjectName("");
      toast({ title: "Pipeline started", description: "Motion tracking processing in background" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const { data: allProjects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });
  const projects = allProjects.filter(p => p.projectType === PROJECT_TYPES.MOTION_TRACK);

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    },
  });

  const canSubmit = sourceVideo && overlayText && !uploadMutation.isPending;

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">AI Motion Tracking</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Automatically track a moving subject and attach floating text or emojis dynamically.
        </p>
      </div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="p-6">
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Project Name</label>
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Tracked Skateboarder"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Overlay Text / Emoji</label>
                <Input
                  value={overlayText}
                  onChange={(e) => setOverlayText(e.target.value)}
                  placeholder="Look at this! 👀"
                />
              </div>
            </div>

            <div className="border-2 border-dashed rounded-xl p-6 flex flex-col items-center max-w-md">
              <Video className="w-8 h-8 mb-3 text-muted-foreground" />
              <span className="text-sm font-medium mb-2">Source Video</span>
              <p className="text-[10px] text-muted-foreground text-center mb-4 max-w-[200px]">
                Upload a video with clear motion. AI will track the subject.
              </p>
              <input type="file" accept="video/*" onChange={e => setSourceVideo(e.target.files?.[0] || null)} className="text-xs" />
            </div>

            <Button onClick={() => uploadMutation.mutate()} disabled={!canSubmit} className="w-full sm:w-auto">
              {uploadMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              Start Tracking
            </Button>
          </div>
        </Card>
      </motion.div>

      {projects.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Your Tracked Videos</h2>
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
