import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Wand2, LogIn, Mail, Lock, User, Loader2, ShieldAlert, Clock } from "lucide-react";

export default function LoginPage() {
  const { login, loginWithGoogle, requestAccess } = useAuth();
  const [mode, setMode] = useState<"main" | "password" | "no_access" | "pending" | "requested">("main");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const [pendingInfo, setPendingInfo] = useState<{ email: string; displayName: string; avatarUrl?: string }>({ email: "", displayName: "" });

  // Fetch Google Client ID from server
  useEffect(() => {
    fetch("/api/auth/config")
      .then((r) => r.json())
      .then((data) => {
        if (data.googleClientId) {
          setGoogleClientId(data.googleClientId);
        }
      })
      .catch(() => {});
  }, []);

  const handleGoogleResponse = useCallback(async (response: any) => {
    setError("");
    setLoading(true);
    try {
      const result = await loginWithGoogle(response.credential);
      if (result.status === "no_access") {
        setPendingInfo({
          email: result.email || "",
          displayName: result.displayName || "",
          avatarUrl: result.avatarUrl,
        });
        setMode("no_access");
      } else if (result.status === "pending") {
        setMode("pending");
      }
    } catch (err: any) {
      setError(err.message || "Google login failed");
    } finally {
      setLoading(false);
    }
  }, [loginWithGoogle]);

  // Load Google Identity Services script and render button
  useEffect(() => {
    if (!googleClientId) return;

    const renderGoogleButton = () => {
      const google = (window as any).google;
      if (!google?.accounts?.id || !googleBtnRef.current) return;

      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleGoogleResponse,
        auto_select: false,
      });

      google.accounts.id.renderButton(googleBtnRef.current, {
        theme: "filled_black",
        size: "large",
        width: 320,
        text: "signin_with",
        shape: "pill",
      });

      setGoogleReady(true);
    };

    // Check if script is already loaded
    if ((window as any).google?.accounts?.id) {
      renderGoogleButton();
      return;
    }

    // Load the script
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      // Small delay to ensure google.accounts.id is ready
      setTimeout(renderGoogleButton, 100);
    };
    document.head.appendChild(script);

    return () => {
      // Cleanup if needed
    };
  }, [googleClientId, handleGoogleResponse, mode]);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRequestAccess = async () => {
    setLoading(true);
    try {
      await requestAccess(pendingInfo.email, pendingInfo.displayName, pendingInfo.avatarUrl);
      setMode("requested");
    } catch {
      setError("Failed to send request");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="relative w-full max-w-md">
        {/* Background glow effect */}
        <div className="absolute -inset-1 bg-gradient-to-r from-primary/20 via-violet-500/20 to-primary/20 rounded-2xl blur-xl opacity-60" />

        <div className="relative bg-card border border-border rounded-2xl p-8 shadow-2xl">
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-violet-600 flex items-center justify-center shadow-lg shadow-primary/25">
                <Wand2 className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">ReelForge</h1>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">
                  Pro Studio
                </p>
              </div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm text-center">
              {error}
            </div>
          )}

          {/* Main login screen */}
          {mode === "main" && (
            <div className="space-y-4">
              <p className="text-center text-muted-foreground text-sm mb-6">
                Sign in to access your workspace
              </p>

              {/* Google Sign In */}
              {googleClientId ? (
                <div className="flex justify-center min-h-[44px]">
                  <div ref={googleBtnRef} />
                  {!googleReady && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading Google...
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground text-center py-2">
                  Google login not configured yet
                </p>
              )}

              {/* Divider */}
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-3 text-muted-foreground">or</span>
                </div>
              </div>

              {/* Switch to password */}
              <button
                onClick={() => setMode("password")}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-border bg-muted/50 hover:bg-muted text-sm text-foreground transition-colors"
              >
                <Lock className="w-4 h-4" />
                Sign in with username & password
              </button>
            </div>
          )}

          {/* Password login */}
          {mode === "password" && (
            <form onSubmit={handlePasswordLogin} className="space-y-4">
              <p className="text-center text-muted-foreground text-sm mb-4">
                Sign in with your account
              </p>

              <div className="space-y-3">
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-muted/50 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                    autoFocus
                    required
                  />
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-muted/50 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
                Sign In
              </button>

              <button
                type="button"
                onClick={() => setMode("main")}
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Back to main login
              </button>
            </form>
          )}

          {/* No access */}
          {mode === "no_access" && (
            <div className="space-y-4 text-center">
              <ShieldAlert className="w-12 h-12 text-amber-500 mx-auto" />
              <h2 className="text-lg font-semibold">Access Required</h2>
              <p className="text-sm text-muted-foreground">
                <strong>{pendingInfo.email}</strong> doesn't have access to ReelForge yet.
              </p>
              <button
                onClick={handleRequestAccess}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                Request Access
              </button>
              <button
                onClick={() => setMode("main")}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Try another account
              </button>
            </div>
          )}

          {/* Pending / Requested */}
          {(mode === "pending" || mode === "requested") && (
            <div className="space-y-4 text-center">
              <Clock className="w-12 h-12 text-primary mx-auto animate-pulse" />
              <h2 className="text-lg font-semibold">Request Sent!</h2>
              <p className="text-sm text-muted-foreground">
                Your access request has been sent to the administrator.
                <br />You'll be able to log in once it's approved.
              </p>
              <button
                onClick={() => { setMode("main"); setError(""); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Back to login
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="mt-8 pt-4 border-t border-border text-center">
            <p className="text-[11px] text-muted-foreground">
              Powered by Gemini AI • reelforge.space
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
