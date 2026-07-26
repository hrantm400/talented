import { motion } from "framer-motion";
import {
  Upload,
  Mic,
  Sparkles,
  AudioLines,
  Film,
  Subtitles,
  FileVideo,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Trash2,
  RotateCw,
  Download,
  Music,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import type { Project } from "@shared/schema";


const PIPELINE_STEPS = [
  { key: "uploading", label: "Upload", icon: Upload, description: "Uploading files" },
  { key: "transcription", label: "Transcribe", icon: Mic, description: "Transcribing voiceover (AI)" },
  { key: "video_curation", label: "Curation", icon: Sparkles, description: "Selecting video segments (AI)" },
  { key: "audio_mixing", label: "Audio", icon: AudioLines, description: "Mixing voiceover + music" },
  { key: "video_composition", label: "Compose", icon: Film, description: "Composing video segments" },
  { key: "subtitle_overlay", label: "Subtitles", icon: Subtitles, description: "Adding captions" },
  { key: "exporting", label: "Export", icon: FileVideo, description: "Exporting final video" },
  { key: "complete", label: "Done", icon: CheckCircle2, description: "Processing complete" },
];

function getStepIndex(step: string): number {
  return PIPELINE_STEPS.findIndex((s) => s.key === step);
}

export function PipelineStatus({ project }: { project: Project }) {
  const currentIndex = getStepIndex(project.currentStep);
  const isFailed = project.status === "failed";
  const isComplete = project.status === "complete";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center gap-1 overflow-x-auto pb-2">
        {PIPELINE_STEPS.map((step, idx) => {
          const StepIcon = step.icon;
          const isActive = idx === currentIndex && !isFailed && !isComplete;
          const isDone = idx < currentIndex || isComplete;
          const isCurrent = idx === currentIndex;

          return (
            <div key={step.key} className="flex items-center">
              <div className="flex flex-col items-center min-w-[56px]">
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-500 ${
                    isFailed && isCurrent
                      ? "bg-destructive/10 text-destructive"
                      : isDone
                        ? "bg-emerald-500/10 text-emerald-500"
                        : isActive
                          ? "bg-primary/10 text-primary animate-pulse"
                          : "bg-muted text-muted-foreground"
                  }`}
                >
                  {isFailed && isCurrent ? (
                    <XCircle className="w-4 h-4" />
                  ) : isDone ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : isActive ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <StepIcon className="w-4 h-4" />
                  )}
                </div>
                <span
                  className={`text-[10px] mt-1.5 font-medium text-center leading-tight ${
                    isDone
                      ? "text-emerald-600 dark:text-emerald-400"
                      : isActive
                        ? "text-primary"
                        : "text-muted-foreground"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {idx < PIPELINE_STEPS.length - 1 && (
                <div
                  className={`w-4 h-0.5 mt-[-14px] transition-colors duration-500 ${
                    idx < currentIndex || isComplete
                      ? "bg-emerald-500/40"
                      : "bg-border"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {isFailed
              ? "Pipeline failed"
              : isComplete
                ? "Processing complete"
                : PIPELINE_STEPS[currentIndex]?.description || "Processing..."}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {project.progress}%
          </span>
        </div>
        <Progress
          value={project.progress}
          className={`h-2 ${isFailed ? "[&>div]:bg-destructive" : isComplete ? "[&>div]:bg-emerald-500" : ""}`}
        />
      </div>

      {isFailed && project.errorMessage && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="rounded-lg bg-destructive/5 border border-destructive/20 p-4"
        >
          <p className="text-sm text-destructive font-medium">Error</p>
          <p className="text-xs text-destructive/80 mt-1">{project.errorMessage}</p>
        </motion.div>
      )}

      {isComplete && project.captionVideoPath && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          <a href={`/api/projects/${project.id}/download/caption`} download>
            <Card className="p-4 hover:bg-muted/50 transition-colors cursor-pointer group">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center">
                  <Subtitles className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">Download</p>
                  <p className="text-xs text-muted-foreground">With subs &amp; logo</p>
                </div>
                <Download className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
            </Card>
          </a>
        </motion.div>
      )}

      {project.musicAttribution && (
        <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
          <div className="flex items-start gap-2">
            <Music className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-500">
                Add this credit to the post description:
              </p>
              <p className="text-xs text-muted-foreground mt-1 break-words">
                {project.musicAttribution}
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(project.musicAttribution || "")}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-muted shrink-0"
              title="Copy attribution"
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

export function ProjectCard({
  project,
  onDelete,
  onRetry,
}: {
  project: Project;
  onDelete: (id: number) => void;
  onRetry?: (id: number) => void;
}) {
  const isProcessing = !["complete", "failed"].includes(project.status);
  const isFailed = project.status === "failed";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                project.status === "complete"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : project.status === "failed"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-primary/10 text-primary"
              }`}
            >
              {isProcessing ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : project.status === "complete" ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : (
                <XCircle className="w-5 h-5" />
              )}
            </div>
            <div>
              <h3 className="font-semibold text-sm">
                {project.name}
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {new Date(project.createdAt).toLocaleString()}
                </span>
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  {project.projectType}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {isFailed && onRetry && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-primary"
                title="Retry — resumes from the last successful step"
                onClick={() => onRetry(project.id)}
              >
                <RotateCw className="w-4 h-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(project.id)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
        <PipelineStatus project={project} />
      </Card>
    </motion.div>
  );
}
