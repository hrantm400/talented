import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Factory } from "lucide-react";

type Rule = { maxMin: number; nv: number; vo: number };
type LogoLayout = { xPct: number; yPct: number; widthPct: number; opacity: number };
type Profile = {
  name?: string;
  captionStyle: string;
  mirror: boolean;
  noise: number;
  logoPosition: "top-left" | "top-right";
  musicMood: string;
  topCard: boolean;
  outro: boolean;
  hookText?: string;
  outroText?: string;
  logoLayout?: LogoLayout;
  hookColor?: string;
};

const CAPTION_STYLES = ["capcut_green", "capcut_yellow", "neon_pop", "minimal_white", "fire", "gradient_glow"];
const MOODS = ["auto", "epic", "emotional", "uplifting", "dramatic", "energetic", "happy", "chill", "dark", "none"];
const HOOK_COLORS = [
  { name: "Purple", rgb: "A020F0" }, { name: "Blue", rgb: "2E7DFF" }, { name: "Orange", rgb: "FF7A00" },
  { name: "Red", rgb: "FF2D2D" }, { name: "Green", rgb: "1FBF4B" }, { name: "Pink", rgb: "FF45A8" },
  { name: "Teal", rgb: "12C2C2" }, { name: "White", rgb: "FFFFFF" }, { name: "Black", rgb: "151515" },
];
const DEFAULT_LOGO_LAYOUT: LogoLayout = { xPct: 0.95, yPct: 0.05, widthPct: 0.18, opacity: 1 };

const newProfile = (): Profile => ({
  captionStyle: "capcut_green", mirror: false, noise: 7, logoPosition: "top-right", musicMood: "auto", topCard: true, outro: true, hookText: "", outroText: "",
});

export function FactorySettings() {
  const { toast } = useToast();
  const [rules, setRules] = useState<Rule[]>([]);
  const [nvProfiles, setNvProfiles] = useState<Profile[]>([]);
  const [voProfiles, setVoProfiles] = useState<Profile[]>([]);
  const [sheetTabNv, setSheetTabNv] = useState("NV");
  const [sheetTabVo, setSheetTabVo] = useState("VO");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/factory-config", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        setRules(d.rules || []);
        setNvProfiles(d.nvProfiles || []);
        setVoProfiles(d.voProfiles || []);
        setSheetTabNv(d.sheetTabNv || "NV");
        setSheetTabVo(d.sheetTabVo || "VO");
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/factory-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rules, nvProfiles, voProfiles, sheetTabNv, sheetTabVo }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      toast({ title: "Saved", description: "Factory settings updated." });
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const ProfileEditor = ({ list, setList, label }: { list: Profile[]; setList: (p: Profile[]) => void; label: string }) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label} ({list.length})</span>
        <Button type="button" variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => setList([...list, newProfile()])}>
          <Plus className="w-3 h-3" />Add
        </Button>
      </div>
      {list.map((p, i) => {
        const upd = (patch: Partial<Profile>) => setList(list.map((x, j) => j === i ? { ...x, ...patch } : x));
        const ll = p.logoLayout;
        const updLogo = (patch: Partial<LogoLayout>) => upd({ logoLayout: { ...(ll || DEFAULT_LOGO_LAYOUT), ...patch } });
        return (
        <div key={i} className="flex flex-col gap-2 p-2 rounded border border-border bg-muted/20 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground w-6">#{i + 1}</span>
            <select value={p.captionStyle} onChange={(e) => upd({ captionStyle: e.target.value })} className="h-7 rounded border border-input bg-background px-1">
              {CAPTION_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={p.logoPosition} onChange={(e) => upd({ logoPosition: e.target.value as any })} className="h-7 rounded border border-input bg-background px-1">
              <option value="top-right">↗ logo</option>
              <option value="top-left">↖ logo</option>
            </select>
            <select value={p.musicMood} onChange={(e) => upd({ musicMood: e.target.value })} className="h-7 rounded border border-input bg-background px-1">
              {MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <label className="flex items-center gap-1"><input type="checkbox" checked={p.mirror} onChange={(e) => upd({ mirror: e.target.checked })} />mirror</label>
            <label className="flex items-center gap-1">noise<input type="number" min={0} max={20} value={p.noise} onChange={(e) => upd({ noise: Number(e.target.value) })} className="w-12 h-7 rounded border border-input bg-background px-1" /></label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={p.topCard} onChange={(e) => upd({ topCard: e.target.checked })} />card</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={p.outro} onChange={(e) => upd({ outro: e.target.checked })} />outro</label>
            <button type="button" onClick={() => setList(list.filter((_, j) => j !== i))} className="ml-auto text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-6">
            {p.topCard && (
              <input value={p.hookText || ""} onChange={(e) => upd({ hookText: e.target.value })} placeholder="Hook text — blank = AI" className="flex-1 min-w-[160px] h-7 rounded border border-input bg-background px-2" />
            )}
            {p.topCard && (
              <span className="flex items-center gap-1">
                <span className="w-4 h-4 rounded border border-border" style={{ backgroundColor: `#${p.hookColor || "A020F0"}` }} title="Headline color" />
                <select value={p.hookColor || "A020F0"} onChange={(e) => upd({ hookColor: e.target.value })} className="h-7 rounded border border-input bg-background px-1" title="Headline color">
                  {HOOK_COLORS.map((c) => <option key={c.rgb} value={c.rgb}>{c.name}</option>)}
                </select>
              </span>
            )}
            {p.outro && (
              <input value={p.outroText || ""} onChange={(e) => upd({ outroText: e.target.value })} placeholder="Outro — blank = “Full video in the comments”" className="flex-1 min-w-[160px] h-7 rounded border border-input bg-background px-2" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-6">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={!!ll} onChange={(e) => upd({ logoLayout: e.target.checked ? DEFAULT_LOGO_LAYOUT : undefined })} />
              custom logo
            </label>
            {ll && (
              <>
                <label className="flex items-center gap-1">w%<input type="number" min={2} max={60} value={Math.round(ll.widthPct * 100)} onChange={(e) => updLogo({ widthPct: Number(e.target.value) / 100 })} className="w-12 h-7 rounded border border-input bg-background px-1" /></label>
                <label className="flex items-center gap-1">opacity%<input type="number" min={0} max={100} value={Math.round(ll.opacity * 100)} onChange={(e) => updLogo({ opacity: Number(e.target.value) / 100 })} className="w-12 h-7 rounded border border-input bg-background px-1" /></label>
                <label className="flex items-center gap-1">x%<input type="number" min={0} max={100} value={Math.round(ll.xPct * 100)} onChange={(e) => updLogo({ xPct: Number(e.target.value) / 100 })} className="w-12 h-7 rounded border border-input bg-background px-1" /></label>
                <label className="flex items-center gap-1">y%<input type="number" min={0} max={100} value={Math.round(ll.yPct * 100)} onChange={(e) => updLogo({ yPct: Number(e.target.value) / 100 })} className="w-12 h-7 rounded border border-input bg-background px-1" /></label>
                <span className="text-muted-foreground">(overrides corner)</span>
              </>
            )}
          </div>
        </div>
        );
      })}
    </div>
  );

  return (
    <div className="bg-card border border-border rounded-xl p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Factory className="w-5 h-5 text-amber-500" />
        <h3 className="font-semibold text-lg">Automated Shorts Factory</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        How many no-voiceover (NV) and voiceover (VO) shorts to make per source, by duration — and the style "profiles" the factory rotates through.
      </p>

      {/* Duration rules */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Duration rules</span>
          <Button type="button" variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => setRules([...rules, { maxMin: 60, nv: 1, vo: 1 }])}>
            <Plus className="w-3 h-3" />Add
          </Button>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            <span className="w-28">Up to (minutes)</span><span className="w-20">NV count</span><span className="w-20">VO count</span>
          </div>
          {rules.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="number" min={1} value={r.maxMin} onChange={(e) => setRules(rules.map((x, j) => j === i ? { ...x, maxMin: Number(e.target.value) } : x))} className="w-28 h-8 rounded border border-input bg-background px-2 text-sm" />
              <input type="number" min={0} value={r.nv} onChange={(e) => setRules(rules.map((x, j) => j === i ? { ...x, nv: Number(e.target.value) } : x))} className="w-20 h-8 rounded border border-input bg-background px-2 text-sm" />
              <input type="number" min={0} value={r.vo} onChange={(e) => setRules(rules.map((x, j) => j === i ? { ...x, vo: Number(e.target.value) } : x))} className="w-20 h-8 rounded border border-input bg-background px-2 text-sm" />
              <button type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="pt-2 border-t border-white/5"><ProfileEditor list={nvProfiles} setList={setNvProfiles} label="No-Voiceover profiles" /></div>
      <div className="pt-2 border-t border-white/5"><ProfileEditor list={voProfiles} setList={setVoProfiles} label="Voiceover profiles" /></div>

      <div className="pt-2 border-t border-white/5 grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium">Google Sheet tab — NV</label>
          <Input value={sheetTabNv} onChange={(e) => setSheetTabNv(e.target.value)} className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Google Sheet tab — VO</label>
          <Input value={sheetTabVo} onChange={(e) => setSheetTabVo(e.target.value)} className="h-8 text-sm" />
        </div>
      </div>

      <Button onClick={save} disabled={saving} className="gap-2">
        {saving ? "Saving…" : "Save factory settings"}
      </Button>
    </div>
  );
}
