import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { queryClient } from "@/lib/queryClient";
import type { Project } from "@shared/schema";
import { useAuth } from "@/hooks/useAuth";
import {
  Film,
  Scissors,
  Mic2,
  Wand2,
  Settings,
  Sparkles,
  Palette,
  AudioLines,
  Rocket,
  Zap,
  Flame,
  Clapperboard,
  Gamepad2,
  Download,
  Shield,
  LogOut,
  Users,
  Bell,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

type NavItem = {
  href: string;
  label: string;
  icon: any;
  description: string;
  feature: string;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Auto-Shorts (Classic)", icon: Film, description: "Convert 16:9 to 9:16 Sandwich", feature: "classic" },
  { href: "/automated-shorts", label: "Automated Shorts", icon: Rocket, description: "Full+short tabs, auto script+voiceover", feature: "automated-shorts" },
  { href: "/elevenlabs", label: "ElevenLabs Voiceover", icon: Mic2, description: "Generate voiceovers from text", feature: "elevenlabs" },
  { href: "/download", label: "Download Video", icon: Download, description: "Fetch videos by URL (yt-dlp)", feature: "download" },
  { href: "/voiceover-script", label: "Viral Voiceover Script", icon: Sparkles, description: "AI script from short video (Gemini 3 Pro)", feature: "voiceover-script" },
  { href: "/smart-crop", label: "AI Smart Crop", icon: Scissors, description: "Auto face-tracking & cropping", feature: "smart-crop" },
  { href: "/auto-ducking", label: "Auto-Ducking", icon: Mic2, description: "Smart background music mixing", feature: "auto-ducking" },
  { href: "/highlights", label: "Podcast Highlights", icon: Wand2, description: "Batch extraction from long videos", feature: "highlights" },
  { href: "/color-grade", label: "AI Color Grade", icon: Palette, description: "Cinematic color correction", feature: "color-grade" },
  { href: "/vocal-isolate", label: "Vocal Isolator", icon: AudioLines, description: "Studio quality audio cleaning", feature: "vocal-isolate" },
  { href: "/motion-track", label: "Motion Track", icon: Film, description: "Dynamic object tracking", feature: "motion-track" },
];

const COMBO_ITEMS: NavItem[] = [
  { href: "/combos/viral", label: "The Viral YouTuber", icon: Rocket, description: "Highlights + Crop + Color + Subs", feature: "combos" },
  { href: "/combos/podcast", label: "Pro Studio Podcast", icon: Mic2, description: "Isolate + Ducking + Subs", feature: "combos" },
  { href: "/combos/action", label: "Action Sports Reel", icon: Zap, description: "Crop + Color + Motion Track", feature: "combos" },
  { href: "/combos/cinematic", label: "Cinematic Storyteller", icon: Clapperboard, description: "Sandwich + Color + Ducking", feature: "combos" },
  { href: "/combos/meme", label: "Faceless Meme Factory", icon: Flame, description: "Isolate + Motion Track + Subs", feature: "combos" },
];

export function Sidebar() {
  const [location] = useLocation();
  const { user, hasFeature, isAdmin, logout } = useAuth();
  const [pendingRequests, setPendingRequests] = useState(0);

  // Fetch pending access requests for admin badge
  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/access-requests", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setPendingRequests(data.filter((r: any) => r.status === "pending").length);
        }
      })
      .catch(() => {});
  }, [isAdmin]);

  const visibleNavItems = NAV_ITEMS.filter((item) => hasFeature(item.feature));
  const visibleComboItems = COMBO_ITEMS.filter((item) => hasFeature(item.feature));

  return (
    <div className="w-64 border-r border-border bg-card/50 backdrop-blur-sm h-screen flex flex-col sticky top-0">
      <div className="p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-violet-600 flex items-center justify-center">
            <Wand2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">ReelForge</h1>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
              Pro Studio
            </p>
          </div>
        </div>
        <Badge variant="outline" className="text-[10px] gap-1.5 w-full justify-center mt-3">
          <Sparkles className="w-3 h-3 text-primary" />
          Powered by Gemini AI
        </Badge>
      </div>

      <div className="flex-1 px-4 space-y-1 overflow-y-auto">
        {visibleNavItems.length > 0 && (
          <>
            <div className="text-xs font-semibold text-muted-foreground mb-3 px-2 mt-4 uppercase tracking-wider">
              AI Tools
            </div>
            {visibleNavItems.map((item) => {
              const isActive = location === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-start gap-3 px-3 py-3 rounded-xl transition-all duration-200 group ${
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${isActive ? "text-primary" : "group-hover:text-foreground"}`} />
                  <div>
                    <div className="text-sm">{item.label}</div>
                    <div className={`text-[10px] mt-0.5 ${isActive ? "text-primary/70" : "text-muted-foreground/70"}`}>
                      {item.description}
                    </div>
                  </div>
                </Link>
              );
            })}
          </>
        )}

        {visibleComboItems.length > 0 && (
          <>
            <div className="text-xs font-semibold text-amber-500 mb-3 px-2 mt-6 uppercase tracking-wider flex items-center gap-2">
              <Zap className="w-3 h-3" />
              Magic Combos
            </div>
            {visibleComboItems.map((item) => {
              const isActive = location === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-start gap-3 px-3 py-3 rounded-xl transition-all duration-200 group ${
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${isActive ? "text-primary" : "group-hover:text-foreground"}`} />
                  <div>
                    <div className="text-sm">{item.label}</div>
                    <div className={`text-[10px] mt-0.5 ${isActive ? "text-primary/70" : "text-muted-foreground/70"}`}>
                      {item.description}
                    </div>
                  </div>
                </Link>
              );
            })}
          </>
        )}
      </div>

      <div className="p-4 mt-auto space-y-1">
        {/* Admin Panel */}
        {isAdmin && (
          <>
            <Link
              href="/admin/users"
              className={`flex items-center gap-3 px-3 py-2 w-full rounded-xl transition-colors text-sm ${
                location.startsWith("/admin/users")
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Users className="w-4 h-4" />
              Users
              {pendingRequests > 0 && (
                <Badge variant="destructive" className="ml-auto text-[10px] px-1.5 py-0">
                  {pendingRequests}
                </Badge>
              )}
            </Link>
            <Link
              href="/admin/settings"
              className={`flex items-center gap-3 px-3 py-2 w-full rounded-xl transition-colors text-sm ${
                location === "/admin/settings"
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Shield className="w-4 h-4" />
              Admin Settings
            </Link>
          </>
        )}

        <Link
          href="/settings"
          className={`flex items-center gap-3 px-3 py-2 w-full rounded-xl transition-colors text-sm ${
            location === "/settings"
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Settings className="w-4 h-4" />
          Settings
        </Link>

        {/* User info + logout */}
        <div className="pt-3 border-t border-border mt-3">
          <div className="flex items-center gap-3 px-2">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} className="w-8 h-8 rounded-full" alt="" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                {(user?.displayName || "?")[0].toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user?.displayName}</p>
              <p className="text-[10px] text-muted-foreground truncate">
                {user?.email || user?.username}
              </p>
            </div>
            <button
              onClick={logout}
              className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MainLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    let socket = new WebSocket(wsUrl);

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "PROJECT_UPDATE" && data.project) {
          queryClient.setQueryData<Project[]>(["/api/projects"], (old) => {
            if (!old) return [data.project];
            const exists = old.find((p) => p.id === data.project.id);
            if (exists) {
              return old.map((p) => (p.id === data.project.id ? data.project : p));
            } else {
              return [data.project, ...old];
            }
          });
        }
      } catch (err) {
        console.error("Failed to parse websocket message", err);
      }
    };

    return () => {
      socket.close();
    };
  }, []);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex-1 flex flex-col min-h-screen overflow-x-hidden">
        {children}
      </div>
    </div>
  );
}
