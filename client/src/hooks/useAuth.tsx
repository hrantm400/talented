import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { type ElevenLabsKey } from "@shared/schema";

type AuthUser = {
  id: number;
  email: string | null;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  isActive: boolean;
  authMethod: string;
  permissions: string[];
  useAdminElevenlabs: boolean;
  useAdminOpenrouter: boolean;
  telegramChatId: string | null;
  telegramNotificationsEnabled: boolean;
  googleSheetId: string | null;
  hasElevenlabsKey: boolean;
  hasOpenrouterKey: boolean;
  hasGoogleSheets: boolean;
  elevenlabsKeys?: ElevenLabsKey[];
  personalModelScript?: string | null;
  personalModelVideo?: string | null;
};

type AuthContextType = {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<{ status: string; email?: string; displayName?: string; avatarUrl?: string }>;
  requestAccess: (email: string, displayName?: string, avatarUrl?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  hasFeature: (feature: string) => boolean;
  isAdmin: boolean;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    setUser(data.user);
  }, []);

  const loginWithGoogle = useCallback(async (credential: string) => {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Google login failed");
    if (data.status === "ok") {
      setUser(data.user);
    }
    return data;
  }, []);

  const requestAccess = useCallback(async (email: string, displayName?: string, avatarUrl?: string) => {
    const res = await fetch("/api/auth/request-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, displayName, avatarUrl }),
      credentials: "include",
    });
    if (!res.ok) throw new Error("Request failed");
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
  }, []);

  const hasFeature = useCallback(
    (feature: string) => {
      if (!user) return false;
      if (user.role === "admin") return true;
      return user.permissions.includes(feature);
    },
    [user]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        loginWithGoogle,
        requestAccess,
        logout,
        refresh,
        hasFeature,
        isAdmin: user?.role === "admin",
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
