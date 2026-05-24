import { useQuery } from "@tanstack/react-query";
import { Mic2, BrainCircuit, AlertTriangle } from "lucide-react";

type Usage = {
  elevenlabs: {
    available: boolean;
    characterCount: number;
    characterLimit: number;
    tier: string;
    resetAt: number | null;
    source: "personal" | "admin";
    error?: string;
  };
  openrouter: {
    available: boolean;
    usage: number;
    limit: number;
    remaining: number | null;
    source: "personal" | "admin";
    error?: string;
  };
};

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatResetDate(unix: number | null): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

export function UsageWidget() {
  // 60s cache so navigating between pages doesn't slam the upstream APIs.
  const { data, isLoading, error } = useQuery<Usage>({
    queryKey: ["/api/usage"],
    refetchInterval: 5 * 60 * 1000, // refresh every 5 minutes
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="bg-card border border-border rounded-xl p-6">
        <p className="text-sm text-muted-foreground">Loading usage…</p>
      </div>
    );
  }

  if (error || !data) {
    return null;
  }

  const el = data.elevenlabs;
  const or = data.openrouter;
  const elPct = el.characterLimit > 0
    ? Math.min(100, (el.characterCount / el.characterLimit) * 100)
    : 0;

  return (
    <div className="bg-card border border-border rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">API Usage</h3>
        <span className="text-[10px] text-muted-foreground">
          (auto-refreshes every 5 min)
        </span>
      </div>

      {/* ElevenLabs */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Mic2 className="w-4 h-4 text-violet-500" />
            <span className="font-medium">ElevenLabs credits</span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full ${
                el.source === "admin"
                  ? "bg-amber-500/10 text-amber-500"
                  : "bg-blue-500/10 text-blue-500"
              }`}
            >
              {el.source === "admin" ? "admin's key" : "your key"}
            </span>
          </span>
          {el.available && (
            <span className="text-xs text-muted-foreground">tier: {el.tier}</span>
          )}
        </div>
        {el.available ? (
          <>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${
                  elPct > 90
                    ? "bg-destructive"
                    : elPct > 70
                      ? "bg-amber-500"
                      : "bg-violet-500"
                }`}
                style={{ width: `${elPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {formatNumber(el.characterCount)} / {formatNumber(el.characterLimit)}{" "}
                characters used
              </span>
              <span>resets {formatResetDate(el.resetAt)}</span>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="w-3.5 h-3.5" />
            {el.error || "Not configured"}
          </div>
        )}
      </div>

      {/* OpenRouter */}
      <div className="space-y-2 pt-3 border-t border-border">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <BrainCircuit className="w-4 h-4 text-indigo-500" />
            <span className="font-medium">OpenRouter balance</span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full ${
                or.source === "admin"
                  ? "bg-amber-500/10 text-amber-500"
                  : "bg-blue-500/10 text-blue-500"
              }`}
            >
              {or.source === "admin" ? "admin's key" : "your key"}
            </span>
          </span>
        </div>
        {or.available ? (
          <div className="text-xs text-muted-foreground">
            {or.limit > 0 ? (
              <>
                <span className="text-foreground font-medium">
                  ${or.remaining?.toFixed(2)} left
                </span>{" "}
                — ${or.usage.toFixed(2)} of ${or.limit.toFixed(2)} used
              </>
            ) : (
              <>
                <span className="text-foreground font-medium">
                  ${or.usage.toFixed(2)} spent
                </span>{" "}
                (pay-as-you-go, no monthly limit)
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="w-3.5 h-3.5" />
            {or.error || "Not configured"}
          </div>
        )}
      </div>
    </div>
  );
}
