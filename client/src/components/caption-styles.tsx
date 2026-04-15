import { CAPTION_STYLES, type CaptionStyle } from "../../../shared/caption-styles";
import { Check } from "lucide-react";
import { motion } from "framer-motion";

interface CaptionStyleSelectorProps {
  selected: string;
  onSelect: (id: string) => void;
}

function CaptionPreview({ style }: { style: CaptionStyle }) {
  const sampleWords = style.uppercase
    ? ["I MEAN", "THE GUY", "WALKED ON", "STAGE"]
    : ["I mean", "the guy", "walked on", "stage"];

  const highlightIndex = 2;

  return (
    <div className="w-full aspect-[9/16] bg-gradient-to-b from-gray-900 via-gray-800 to-black rounded-lg overflow-hidden relative flex items-end justify-center pb-[20%]">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/60" />

      <div className="relative z-10 text-center px-2 leading-relaxed">
        <div className="flex flex-wrap justify-center gap-x-1">
          {sampleWords.map((word, i) => (
            <span
              key={i}
              className="font-black tracking-wide"
              style={{
                color: i === highlightIndex ? style.cssHighlightColor : style.cssPrimaryColor,
                fontSize: "10px",
                textShadow: "0 1px 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.5)",
                transform: i === highlightIndex ? `scale(${style.scaleOnHighlight / 100})` : "scale(1)",
                display: "inline-block",
                lineHeight: 1.4,
              }}
            >
              {word}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CaptionStyleSelector({ selected, onSelect }: CaptionStyleSelectorProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-medium mb-1 block">Caption Style</label>
        <p className="text-xs text-muted-foreground">
          Choose how your captions will look in the final video
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {CAPTION_STYLES.map((style) => {
          const isSelected = selected === style.id;
          return (
            <motion.button
              key={style.id}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => onSelect(style.id)}
              className={`relative rounded-xl overflow-hidden transition-all duration-200 text-left group ${
                isSelected
                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : "ring-1 ring-border hover:ring-primary/40"
              }`}
              data-testid={`caption-style-${style.id}`}
            >
              <CaptionPreview style={style} />

              <div className="p-2 bg-card border-t border-border">
                <p className="text-[11px] font-semibold truncate">{style.name}</p>
                <p className="text-[9px] text-muted-foreground truncate mt-0.5">
                  {style.description}
                </p>
              </div>

              {isSelected && (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center"
                >
                  <Check className="w-3 h-3 text-primary-foreground" />
                </motion.div>
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
