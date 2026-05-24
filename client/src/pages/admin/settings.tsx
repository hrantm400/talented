import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Shield, Key, Save, Bot, CheckCircle2, BrainCircuit, ShieldAlert, Eye, EyeOff, Loader2, RefreshCw, DollarSign } from "lucide-react";
import { ModelSelector } from "@/components/model-selector";
import { ApiKeyManager } from "@/components/api-key-manager";
import { type ElevenLabsKey } from "@shared/schema";

export default function AdminSettingsPage() {
  const { isAdmin } = useAuth();
  const [settings, setSettings] = useState<any>(null);
  const [elevenlabsKeys, setElevenlabsKeys] = useState<ElevenLabsKey[]>([]);
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [defaultModelScript, setDefaultModelScript] = useState<string | null>(null);
  const [defaultModelVideo, setDefaultModelVideo] = useState<string | null>(null);
  const [defaultModelWhisper, setDefaultModelWhisper] = useState<string>("");
  const [mullvadEnabled, setMullvadEnabled] = useState(false);
  const [mullvadPrivateKey, setMullvadPrivateKey] = useState("");
  const [mullvadAddress, setMullvadAddress] = useState("");
  const [mullvadCountry, setMullvadCountry] = useState("Sweden");
  const [showOpenrouterKey, setShowOpenrouterKey] = useState(false);
  const [showMullvadKey, setShowMullvadKey] = useState(false);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [apiUsage, setApiUsage] = useState<any>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const fetchUsage = () => {
    setUsageLoading(true);
    fetch("/api/admin/api-usage", { credentials: "include" })
      .then((r) => r.json())
      .then(setApiUsage)
      .catch(() => {})
      .finally(() => setUsageLoading(false));
  };

  useEffect(() => {
    fetch("/api/admin/settings", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        setSettings(data);
        setElevenlabsKeys(data.elevenlabsKeys || []);
        setDefaultModelScript(data.defaultModelScript || null);
        setDefaultModelVideo(data.defaultModelVideo || null);
        setDefaultModelWhisper(data.defaultModelWhisper || "");
        setTelegramChatId(data.telegramAdminChatId || "");
        setMullvadEnabled(data.mullvadEnabled || false);
        setMullvadPrivateKey(data.mullvadPrivateKey || "");
        setMullvadAddress(data.mullvadAddress || "");
        setMullvadCountry(data.mullvadCountry || "Sweden");
      });
    fetchUsage();
  }, []);

  if (!isAdmin) return <div className="p-8 text-center text-muted-foreground">Admin access required</div>;

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    const body: any = {
      telegramAdminChatId: telegramChatId,
      defaultModelScript,
      defaultModelVideo,
      defaultModelWhisper: defaultModelWhisper.trim() || null,
      elevenlabsKeys,
      mullvadEnabled,
      mullvadCountry,
    };
    if (openrouterKey) body.openrouterApiKey = openrouterKey;
    if (mullvadPrivateKey) body.mullvadPrivateKey = mullvadPrivateKey;
    if (mullvadAddress) body.mullvadAddress = mullvadAddress;

    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      // Refresh settings
      const newSettings = await fetch("/api/admin/settings", { credentials: "include" }).then(r => r.json());
      setSettings(newSettings);
      setElevenlabsKeys(newSettings.elevenlabsKeys || []);
      setOpenrouterKey("");
    }
  };

  return (
    <div className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Shield className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Admin Settings</h1>
          <p className="text-sm text-muted-foreground">Global API keys and integrations</p>
        </div>
      </div>

      {saved && (
        <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-green-500 text-sm">
          <CheckCircle2 className="w-4 h-4" />
          Settings saved successfully
        </div>
      )}

      {/* API Balance */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-emerald-500" />
            <h3 className="font-semibold text-lg">API Balance</h3>
          </div>
          <button
            onClick={fetchUsage}
            disabled={usageLoading}
            className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted"
            title="Refresh"
          >
            {usageLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
        </div>

        {usageLoading && !apiUsage ? (
          <p className="text-xs text-muted-foreground">Loading balances...</p>
        ) : apiUsage ? (
          <div className="space-y-3">
            {/* ElevenLabs keys */}
            {apiUsage.elevenlabs?.length > 0 ? (
              apiUsage.elevenlabs.map((el: any, i: number) => {
                const used = el.characterCount;
                const limit = el.characterLimit;
                const remaining = Math.max(0, limit - used);
                const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
                const barColor = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500";
                return (
                  <div key={i} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium flex items-center gap-1.5">
                        <Key className="w-3.5 h-3.5 text-primary" />
                        {el.name}
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground uppercase">{el.tier}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {remaining.toLocaleString()} / {limit.toLocaleString()} chars left
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-muted-foreground">No ElevenLabs keys configured</p>
            )}

            {/* OpenRouter */}
            {apiUsage.openrouter ? (
              <div className="pt-2 border-t border-border space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-violet-500" />
                    OpenRouter
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ${(apiUsage.openrouter.usage ?? 0).toFixed(2)} used
                    {apiUsage.openrouter.credits > 0 && (
                      <> / ${(apiUsage.openrouter.credits).toFixed(2)} limit</>
                    )}
                  </span>
                </div>
                {apiUsage.openrouter.credits > 0 && (() => {
                  const pct = Math.round((apiUsage.openrouter.usage / apiUsage.openrouter.credits) * 100);
                  const remaining = Math.max(0, apiUsage.openrouter.credits - apiUsage.openrouter.usage);
                  const barColor = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-violet-500";
                  return (
                    <>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <p className="text-xs text-emerald-500 font-medium">${remaining.toFixed(2)} remaining</p>
                    </>
                  );
                })()}
              </div>
            ) : settings?.hasOpenrouterKey ? (
              <div className="pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground">OpenRouter: could not fetch balance</p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Could not load balances</p>
        )}
      </div>

      {/* ElevenLabs */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Key className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">ElevenLabs (Global)</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          These keys are used by users who have "Use admin ElevenLabs key" enabled.
          The active key will be used for generation.
        </p>
        
        <ApiKeyManager 
          keys={elevenlabsKeys} 
          onChange={setElevenlabsKeys} 
        />
      </div>

      {/* OpenRouter */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-violet-500" />
          <h3 className="font-semibold">OpenRouter (Global)</h3>
          {settings?.hasOpenrouterKey && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">Configured</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Used for AI voiceover script generation. Users with "Use admin OpenRouter key" will use this.
        </p>
        <div className="relative">
          <input
            placeholder={settings?.hasOpenrouterKey ? "••• Key is set (enter new to change)" : "OpenRouter API Key"}
            value={openrouterKey}
            onChange={(e) => setOpenrouterKey(e.target.value)}
            className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm pr-10"
            type={showOpenrouterKey ? "text" : "password"}
          />
          <button
            onClick={() => setShowOpenrouterKey(!showOpenrouterKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showOpenrouterKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Default AI Models */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <BrainCircuit className="w-5 h-5 text-indigo-400" />
          <h3 className="font-semibold text-lg">Default AI Models</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Choose which OpenRouter AI models the platform should use by default. Users can override these in their personal settings.
        </p>

        <ModelSelector
          label="Voiceover Script Writer"
          description="Model used to write viral short video scripts from transcripts."
          value={defaultModelScript}
          onChange={setDefaultModelScript}
        />

        <div className="pt-4 border-t border-white/5">
          <ModelSelector
            label="Video Analysis & Hook Detection"
            description="Model used to analyze video frames. MUST support Vision."
            value={defaultModelVideo}
            onChange={setDefaultModelVideo}
            requireVision
          />
        </div>

        <div className="pt-4 border-t border-white/5">
          <label className="block text-[0.95rem] font-semibold text-foreground mb-1">
            Whisper Transcription Model
          </label>
          <p className="text-[0.85rem] text-muted-foreground mb-2">
            Default: <code className="bg-muted px-1 rounded">local</code> (faster-whisper on this server — required for word-level subtitles).
            <br />
            You can paste any OpenRouter model id (e.g. <code className="bg-muted px-1 rounded">openai/whisper-large-v3-turbo</code>) — but note that OpenRouter currently returns text only, no per-word timestamps, so the pipeline will auto-fallback to local for subtitles.
          </p>
          <input
            type="text"
            value={defaultModelWhisper}
            onChange={(e) => setDefaultModelWhisper(e.target.value)}
            placeholder="local"
            className="w-full px-4 py-3 bg-card border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary shadow-sm"
          />
        </div>
      </div>

      {/* Mullvad VPN */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <ShieldAlert className="w-5 h-5 text-emerald-500" />
          <h3 className="font-semibold text-lg">Mullvad VPN Downloader</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Bypass YouTube blocking using isolated WireGuard Docker proxy. Do not share these keys.
        </p>

        <div className="flex items-center gap-2 mb-4">
          <input
            type="checkbox"
            id="mullvadEnabled"
            checked={mullvadEnabled}
            onChange={(e) => setMullvadEnabled(e.target.checked)}
            className="w-4 h-4 text-primary bg-muted border-border rounded focus:ring-primary"
          />
          <label htmlFor="mullvadEnabled" className="text-sm font-medium">
            Enable Mullvad VPN Proxy (yt-dlp)
          </label>
        </div>

        {mullvadEnabled && (
          <div className="space-y-4 p-4 border border-dashed rounded-lg bg-muted/20">
            <div className="space-y-1">
              <label className="text-xs font-semibold">WireGuard Private Key</label>
              <div className="relative">
                <input
                  placeholder={settings?.mullvadPrivateKey ? "••• Key is set (enter new to change)" : "PrivKey..."}
                  value={mullvadPrivateKey}
                  onChange={(e) => setMullvadPrivateKey(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono pr-10"
                  type={showMullvadKey ? "text" : "password"}
                />
                <button
                  onClick={() => setShowMullvadKey(!showMullvadKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showMullvadKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold">Device Address (IPv4/IPv6)</label>
              <input
                placeholder="e.g. 10.64.12.3/32,fc00:bbbb:bbbb:bb01::1:1cf0/128"
                value={mullvadAddress}
                onChange={(e) => setMullvadAddress(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold">Server Country</label>
              <select
                value={mullvadCountry}
                onChange={(e) => setMullvadCountry(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              >
                <option value="Sweden">Sweden</option>
                <option value="Switzerland">Switzerland</option>
                <option value="Germany">Germany</option>
                <option value="Netherlands">Netherlands</option>
                <option value="USA">USA</option>
                <option value="UK">United Kingdom</option>
                <option value="France">France</option>
                <option value="Spain">Spain</option>
                <option value="Italy">Italy</option>
                <option value="Poland">Poland</option>
                <option value="Japan">Japan</option>
                <option value="Singapore">Singapore</option>
                <option value="Canada">Canada</option>
                <option value="Australia">Australia</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Telegram */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-blue-500" />
          <h3 className="font-semibold">Telegram Notifications</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Your Chat ID for receiving admin notifications (access requests, etc.).
          Send /start to @Reelforgespace_bot to get your Chat ID.
        </p>
        <input
          placeholder="Admin Telegram Chat ID"
          value={telegramChatId}
          onChange={(e) => setTelegramChatId(e.target.value)}
          className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm"
        />
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        <Save className="w-4 h-4" />
        {saving ? "Saving..." : "Save Settings"}
      </button>
    </div>
  );
}
