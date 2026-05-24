import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Settings as SettingsIcon, Key, Bot, Save, CheckCircle2, Table2, BrainCircuit } from "lucide-react";
import { CleanupSettingsCard } from "@/components/cleanup-settings";
import { ModelSelector } from "@/components/model-selector";
import { ApiKeyManager } from "@/components/api-key-manager";
import { UsageWidget } from "@/components/usage-widget";
import { type ElevenLabsKey } from "@shared/schema";

export default function SettingsPage() {
  const { user, isAdmin, refresh } = useAuth();
  const [elevenlabsKeys, setElevenlabsKeys] = useState<ElevenLabsKey[]>(user?.elevenlabsKeys || []);
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [telegramChatId, setTelegramChatId] = useState(user?.telegramChatId || "");
  const [telegramEnabled, setTelegramEnabled] = useState(user?.telegramNotificationsEnabled || false);
  const [googleSheetId, setGoogleSheetId] = useState("");
  const [googleServiceJson, setGoogleServiceJson] = useState("");
  const [personalModelScript, setPersonalModelScript] = useState<string | null>(null);
  const [personalModelVideo, setPersonalModelVideo] = useState<string | null>(null);
  const [personalModelWhisper, setPersonalModelWhisper] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Fetch current user settings
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.user) {
          setTelegramChatId(data.user.telegramChatId || "");
          setTelegramEnabled(data.user.telegramNotificationsEnabled || false);
          setGoogleSheetId(data.user.googleSheetId || "");
          setPersonalModelScript(data.user.personalModelScript || null);
          setPersonalModelVideo(data.user.personalModelVideo || null);
          setPersonalModelWhisper(data.user.personalModelWhisper || "");
          setElevenlabsKeys(data.user.elevenlabsKeys || []);
        }
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    const body: any = {
      telegramChatId: telegramChatId || null,
      telegramNotificationsEnabled: telegramEnabled,
      googleSheetId: googleSheetId || null,
      personalModelScript,
      personalModelVideo,
      personalModelWhisper: personalModelWhisper.trim() || null,
      elevenlabsKeys,
    };
    if (openrouterKey) body.openrouterApiKey = openrouterKey;
    if (googleServiceJson) body.googleServiceAccountJson = googleServiceJson;

    const res = await fetch("/api/user/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setOpenrouterKey("");
      setGoogleServiceJson("");
      refresh();
      setTimeout(() => setSaved(false), 3000);
    }
  };

  return (
    <div className="flex-1 w-full max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <SettingsIcon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Your personal API keys and integrations</p>
        </div>
      </div>

      {saved && (
        <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-green-500 text-sm">
          <CheckCircle2 className="w-4 h-4" />
          Settings saved
        </div>
      )}

      {/* Profile */}
      <div className="bg-card border border-border rounded-xl p-6">
        <div className="flex items-center gap-4">
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} className="w-14 h-14 rounded-full" />
          ) : (
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-xl font-bold text-primary">
              {(user?.displayName || "?")[0].toUpperCase()}
            </div>
          )}
          <div>
            <p className="text-lg font-semibold">{user?.displayName}</p>
            <p className="text-sm text-muted-foreground">{user?.email || user?.username}</p>
            <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full ${user?.role === "admin" ? "bg-amber-500/10 text-amber-500" : "bg-muted text-muted-foreground"}`}>
              {user?.role}
            </span>
          </div>
        </div>
      </div>

      {/* API Usage / Balance */}
      <UsageWidget />

      {/* API Keys */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">API Keys</h3>
        </div>

        {/* ElevenLabs */}
        <div className="space-y-4">
          <label className="text-sm font-medium flex items-center gap-2">
            ElevenLabs
            {user?.useAdminElevenlabs && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">Using admin key ✓</span>
            )}
          </label>
          <p className="text-[11px] text-muted-foreground mt-0">
            {user?.useAdminElevenlabs
              ? "Admin has shared their key with you. You can also add your own personal keys below to override it."
              : "Set your own keys or ask admin to share theirs."}
          </p>
          
          <ApiKeyManager 
            keys={elevenlabsKeys} 
            onChange={setElevenlabsKeys} 
          />
        </div>

        {/* OpenRouter */}
        <div className="space-y-2">
          <label className="text-sm font-medium flex items-center gap-2">
            OpenRouter
            {user?.useAdminOpenrouter && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">Using admin key ✓</span>
            )}
            {user?.hasOpenrouterKey && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500">Personal key set</span>
            )}
          </label>
          <input
            placeholder={user?.hasOpenrouterKey ? "••• Your key is set (enter new to change)" : "Your OpenRouter API Key (optional)"}
            value={openrouterKey}
            onChange={(e) => setOpenrouterKey(e.target.value)}
            className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm"
            type="password"
          />
        </div>

        {/* Override Models */}
        <div className="mt-6 pt-6 border-t border-white/5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <BrainCircuit className="w-4 h-4 text-indigo-400" />
            <h4 className="font-semibold text-sm">Personal AI Models</h4>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            If selected, these models will override the global defaults set by the Admin.
          </p>

          <ModelSelector
            label="Personal Script Writer"
            value={personalModelScript}
            onChange={setPersonalModelScript}
          />

          <div className="pt-2">
            <ModelSelector
              label="Personal Video Analysis"
              value={personalModelVideo}
              onChange={setPersonalModelVideo}
              requireVision
            />
          </div>

          <div className="pt-4 border-t border-white/5">
            <label className="block text-[0.95rem] font-semibold text-foreground mb-1">
              Personal Whisper Model
            </label>
            <p className="text-[0.85rem] text-muted-foreground mb-2">
              Override the admin default. Paste an OpenRouter model id (e.g. <code className="bg-muted px-1 rounded">openai/whisper-large-v3-turbo</code>), or <code className="bg-muted px-1 rounded">local</code> to use the bundled CPU Whisper.
            </p>
            <input
              type="text"
              value={personalModelWhisper}
              onChange={(e) => setPersonalModelWhisper(e.target.value)}
              placeholder="Leave empty to use admin default"
              className="w-full px-4 py-3 bg-card border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary shadow-sm"
            />
          </div>
        </div>
      </div>

      {/* Google Sheets */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Table2 className="w-4 h-4 text-green-500" />
          <h3 className="font-semibold">Google Sheets</h3>
          {user?.hasGoogleSheets && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">Configured ✓</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Completed automated videos will be logged to your personal Google Sheet.
        </p>
        <input
          placeholder="Google Sheet ID"
          value={googleSheetId}
          onChange={(e) => setGoogleSheetId(e.target.value)}
          className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm"
        />
        <textarea
          placeholder="Google Service Account JSON (paste the entire JSON here)"
          value={googleServiceJson}
          onChange={(e) => setGoogleServiceJson(e.target.value)}
          className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm h-24 font-mono"
        />
      </div>

      {/* Telegram */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-blue-500" />
          <h3 className="font-semibold">Telegram Notifications</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Send <code>/start</code> to{" "}
          <a href="https://t.me/Reelforgespace_bot" target="_blank" className="text-primary hover:underline">
            @Reelforgespace_bot
          </a>{" "}
          to get your Chat ID.
        </p>
        <input
          placeholder="Your Telegram Chat ID"
          value={telegramChatId}
          onChange={(e) => setTelegramChatId(e.target.value)}
          className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm"
        />
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={telegramEnabled}
            onChange={(e) => setTelegramEnabled(e.target.checked)}
            className="rounded"
          />
          <span className="text-sm">Notify me when videos are ready</span>
        </label>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        <Save className="w-4 h-4" />
        {saving ? "Saving..." : "Save Settings"}
      </button>

      {/* Storage cleanup (admin only) */}
      {isAdmin && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Storage</h2>
          <CleanupSettingsCard />
        </section>
      )}
    </div>
  );
}
