import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type ElevenSettingsResponse = {
  hasKey: boolean;
  plan: "free" | "paid";
  keyLabel: string | null;
};

export function ElevenLabsSettingsCard() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<ElevenSettingsResponse>({
    queryKey: ["/api/elevenlabs/settings"],
  });

  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [plan, setPlan] = useState<"free" | "paid">("free");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/elevenlabs/settings", {
        apiKey,
        plan,
        keyLabel: label || null,
      });
      return res.json() as Promise<ElevenSettingsResponse>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/elevenlabs/settings"] });
      toast({
        title: "Settings saved",
        description: "ElevenLabs API key is stored on the server.",
      });
      setApiKey("");
    },
    onError: (err: Error) => {
      toast({
        title: "Save failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const currentPlan = data?.plan ?? plan;

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">ElevenLabs settings</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Your API key is stored securely on the server (Postgres), not in the browser.
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading current settings...</p>
      ) : (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Status:{" "}
            {data?.hasKey ? (
              <span className="text-emerald-500 font-medium">Key saved ({data.plan} plan)</span>
            ) : (
              <span className="text-destructive font-medium">No key saved yet</span>
            )}
          </p>
          {data?.keyLabel && (
            <p>
              Label: <span className="font-medium text-foreground">{data.keyLabel}</span>
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs font-medium">API key</label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste your ElevenLabs secret key..."
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium">Key label (optional)</label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Main account, Free tier"
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium">Plan</label>
        <Select
          defaultValue={currentPlan}
          onValueChange={(val) => setPlan(val as "free" | "paid")}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="free">Free</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button
        type="button"
        size="sm"
        className="w-full mt-1"
        disabled={saveMutation.isPending || !apiKey.trim()}
        onClick={() => saveMutation.mutate()}
      >
        {saveMutation.isPending ? "Saving..." : "Save settings"}
      </Button>
    </Card>
  );
}

