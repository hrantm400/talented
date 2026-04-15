import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Info, Check, Brain, Eye, Zap, Image as ImageIcon } from "lucide-react";

interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  pricing: {
    prompt: string;
    completion: string;
  };
  context_length: number;
  architecture: {
    modality: string;
    tokenizer: string;
    instruct_type: string | null;
  };
  top_provider: {
    max_completion_tokens: number | null;
    is_moderated: boolean;
  };
}

interface ModelSelectorProps {
  value: string | null;
  onChange: (value: string) => void;
  label: string;
  description?: string;
  requireVision?: boolean;
}

export function ModelSelector({ value, onChange, label, description, requireVision }: ModelSelectorProps) {
  const [search, setSearch] = useState("");
  const [showFreeOnly, setShowFreeOnly] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const { data: routeData, isLoading, error } = useQuery({
    queryKey: ["/api/openrouter/models"],
    queryFn: async () => {
      const res = await fetch("/api/openrouter/models");
      if (!res.ok) throw new Error("Failed to fetch models");
      return res.json();
    },
    staleTime: 60 * 1000 * 5, // 5 minutes
  });

  const models: OpenRouterModel[] = routeData?.data || [];

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (search && !m.name.toLowerCase().includes(search.toLowerCase()) && !m.id.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }
      if (showFreeOnly && m.pricing.prompt !== "0" && m.pricing.completion !== "0") {
        return false;
      }
      if (requireVision && !m.architecture?.modality?.includes("image")) {
        return false;
      }
      return true;
    });
  }, [models, search, showFreeOnly, requireVision]);

  const selectedModel = models.find((m) => m.id === value) || null;

  return (
    <div className="relative mb-5">
      <div className="mb-2">
        <label className="block text-[0.95rem] font-semibold text-foreground">
          {label}
        </label>
        {description && (
          <p className="text-[0.85rem] text-muted-foreground my-1">
            {description}
          </p>
        )}
      </div>

      <div 
        onClick={() => setIsOpen(!isOpen)}
        className="flex justify-between items-center px-4 py-3 bg-card border border-border rounded-lg cursor-pointer hover:bg-muted/50 transition-all shadow-sm"
      >
        <div>
          {isLoading ? (
            <span className="text-muted-foreground">Loading AI Models...</span>
          ) : error ? (
            <span className="text-destructive">Error loading models. Check API Key.</span>
          ) : selectedModel ? (
            <div className="flex items-center gap-2">
              <Brain size={16} className="text-primary" />
              <span className="font-medium text-foreground">{selectedModel.name}</span>
              <span className="text-[0.8rem] text-muted-foreground">{selectedModel.id}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">Select a model (using defaults)</span>
          )}
        </div>
        <div className={`transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}>
          ▼
        </div>
      </div>

      {isOpen && !isLoading && !error && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-popover border border-border rounded-xl shadow-lg z-[100] overflow-hidden flex flex-col max-h-[400px]">
          {/* Header & Search */}
          <div className="p-4 border-b border-border bg-muted/20">
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search models..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full py-2.5 pl-9 pr-3 bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-primary shadow-inner"
              />
            </div>
            <div className="flex gap-3 items-center">
              <label className="flex items-center gap-1.5 text-[0.85rem] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                <input 
                  type="checkbox" 
                  checked={showFreeOnly} 
                  onChange={(e) => setShowFreeOnly(e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                Free only
              </label>
              {requireVision && (
                <span className="text-[0.8rem] text-emerald-600 dark:text-emerald-500 flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                  <ImageIcon size={12} /> Vision Required
                </span>
              )}
            </div>
          </div>

          {/* Model List */}
          <div className="overflow-y-auto flex-1 p-2 bg-popover">
            {filteredModels.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">
                No models match your search.
              </div>
            ) : (
              filteredModels.map((model) => {
                const isSelected = value === model.id;
                const isFree = model.pricing.prompt === "0" && model.pricing.completion === "0";
                const hasVision = model.architecture?.modality?.includes("image");

                return (
                  <div
                    key={model.id}
                    onClick={() => {
                      onChange(model.id);
                      setIsOpen(false);
                    }}
                    className={`p-3 rounded-lg cursor-pointer border mb-1 flex items-start transition-colors ${
                      isSelected 
                        ? 'border-primary/30 bg-primary/10' 
                        : 'border-transparent hover:bg-muted/50'
                    }`}
                  >
                    <div className={`mr-3 mt-0.5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>
                      {isSelected ? <Check size={18} /> : <div className="w-[18px] h-[18px] rounded-full border border-muted-foreground/40" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <strong className={`font-medium text-[0.95rem] ${isSelected ? 'text-foreground' : 'text-foreground/90'}`}>
                          {model.name}
                        </strong>
                        {isFree && (
                          <span className="text-[0.7rem] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                            <Zap size={10} /> Free
                          </span>
                        )}
                        {hasVision && (
                          <span className="text-[0.7rem] bg-blue-500/10 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                            <Eye size={10} /> Vision
                          </span>
                        )}
                      </div>
                      <div className="text-[0.8rem] text-muted-foreground mb-2">{model.id}</div>
                      
                      <div className="flex gap-4 text-[0.75rem] text-muted-foreground/80">
                        <span>Context: {(model.context_length / 1000).toFixed(0)}k</span>
                        {!isFree && (
                          <span>
                            Cost: ${(Number(model.pricing.prompt) * 1000000).toFixed(2)}/M in, ${(Number(model.pricing.completion) * 1000000).toFixed(2)}/M out
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
