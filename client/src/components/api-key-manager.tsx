import React, { useState } from "react";
import { Plus, Trash2, Key, CheckCircle2, Zap } from "lucide-react";
import { type ElevenLabsKey } from "@shared/schema";

export function ApiKeyManager({
  keys,
  onChange,
}: {
  keys: ElevenLabsKey[];
  onChange: (keys: ElevenLabsKey[]) => void;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newPlan, setNewPlan] = useState<"free" | "paid">("free");

  const handleAdd = () => {
    if (!newName.trim() || !newKey.trim()) return;

    const keyEntry: ElevenLabsKey = {
      id: Math.random().toString(36).substring(7),
      name: newName.trim(),
      key: newKey.trim(),
      plan: newPlan,
      isActive: keys.length === 0, // Auto-activate if it's the first key
    };

    onChange([...keys, keyEntry]);
    setIsAdding(false);
    setNewName("");
    setNewKey("");
    setNewPlan("free");
  };

  const handleRemove = (id: string) => {
    const newKeys = keys.filter((k) => k.id !== id);
    // If we removed the active key, make the first one active
    if (keys.find((k) => k.id === id)?.isActive && newKeys.length > 0) {
      newKeys[0].isActive = true;
    }
    onChange(newKeys);
  };

  const handleSetActive = (id: string) => {
    onChange(
      keys.map((k) => ({
        ...k,
        isActive: k.id === id,
      }))
    );
  };

  return (
    <div className="space-y-4">
      {keys.length > 0 ? (
        <div className="space-y-2">
          {keys.map((k) => (
            <div
              key={k.id}
              className={`p-3 rounded-lg border transition-colors flex items-center justify-between ${
                k.isActive
                  ? "border-primary/50 bg-primary/5"
                  : "border-border bg-card"
              }`}
            >
              <div className="flex items-center gap-3">
                <button
                  type="button" // Important for forms
                  onClick={() => handleSetActive(k.id)}
                  className={`w-5 h-5 rounded-full flex items-center justify-center border transition-colors ${
                    k.isActive
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/30 hover:border-primary/50"
                  }`}
                >
                  {k.isActive && <CheckCircle2 className="w-3.5 h-3.5" />}
                </button>

                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{k.name}</span>
                    <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {k.plan}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <Key className="w-3 h-3" />
                    {k.key === "sk_...***" ? k.key : k.key.substring(0, 8) + "..."}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button" // Important for forms
                  onClick={() => handleRemove(k.id)}
                  className="p-1.5 text-muted-foreground hover:text-destructive transition-colors rounded-md"
                  title="Remove Key"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground p-4 text-center border border-dashed rounded-lg">
          No keys added yet. Add one to get started!
        </div>
      )}

      {isAdding ? (
        <div className="p-3 bg-muted/30 border rounded-lg space-y-3">
          <input
            placeholder="Label (e.g. My Pro Key)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full px-3 py-1.5 bg-background border rounded-md text-sm"
          />
          <input
            placeholder="sk_..."
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            className="w-full px-3 py-1.5 bg-background border rounded-md text-sm font-mono"
            type="password"
          />
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={newPlan === "free"}
                onChange={() => setNewPlan("free")}
                className="text-primary focus:ring-primary"
              />
              Free Plan
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={newPlan === "paid"}
                onChange={() => setNewPlan("paid")}
                className="text-primary focus:ring-primary"
              />
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              Creator/Pro Plan
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              type="button" // Important for forms
              disabled={!newName.trim() || !newKey.trim()}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              Add Key
            </button>
            <button
              onClick={() => setIsAdding(false)}
              type="button" // Important for forms
              className="px-3 py-1.5 bg-muted text-muted-foreground rounded-md text-sm hover:bg-muted/80"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          type="button" // Important for forms
          className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline px-1 py-0.5"
        >
          <Plus className="w-4 h-4" />
          Add API Key
        </button>
      )}
    </div>
  );
}
