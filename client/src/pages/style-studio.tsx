import { motion } from "framer-motion";
import { Type, AlertCircle } from "lucide-react";
import { Card } from "@/components/ui/card";

export default function StyleStudio() {
  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Style Studio</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Create, edit, and save custom subtitle styles. Upload your own fonts to make unique captions.
        </p>
      </div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="p-12 text-center border-dashed border-2 flex flex-col items-center justify-center">
          <div className="w-16 h-16 rounded-2xl bg-pink-500/10 flex items-center justify-center mb-6">
            <Type className="w-8 h-8 text-pink-500" />
          </div>
          <h2 className="text-xl font-bold mb-2">Coming Soon</h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-6">
            Upload custom TrueType (.ttf) fonts and pick brand colors to generate personalized ASS subtitle files for your videos.
          </p>
          <div className="flex items-center gap-2 text-sm text-amber-500 bg-amber-500/10 px-4 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" />
            <span>Interactive font editor arriving soon.</span>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}
