import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import ElevenLabsPage from "@/pages/elevenlabs";
import DownloadPage from "@/pages/download";
import VoiceoverScriptPage from "@/pages/voiceover-script";
import AutomatedShortsPage from "@/pages/automated-shorts";
import AutomatedShortsNoVoiceoverPage from "@/pages/automated-shorts-no-voiceover";
import AutomatedShortsFactoryPage from "@/pages/automated-shorts-factory";
import LoginPage from "@/pages/login";
import AdminSettingsPage from "@/pages/admin/settings";
import { MainLayout } from "@/components/layout";
import { Loader2 } from "lucide-react";

function ProtectedRoute({
  feature,
  adminOnly,
  component: Component,
}: {
  feature?: string;
  adminOnly?: boolean;
  component: React.ComponentType;
}) {
  const { hasFeature, isAdmin } = useAuth();
  const denied =
    (adminOnly && !isAdmin) || (feature && !hasFeature(feature));
  if (denied) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-lg font-semibold text-muted-foreground">🔒 Access Denied</p>
          <p className="text-sm text-muted-foreground">You don't have permission to use this tool.</p>
        </div>
      </div>
    );
  }
  return <Component />;
}

function AuthenticatedApp() {
  return (
    <MainLayout>
      <Switch>
        <Route path="/" component={() => <ProtectedRoute feature="classic" component={Home} />} />
        <Route path="/elevenlabs" component={() => <ProtectedRoute feature="elevenlabs" component={ElevenLabsPage} />} />
        <Route path="/download" component={() => <ProtectedRoute feature="download" component={DownloadPage} />} />
        <Route path="/voiceover-script" component={() => <ProtectedRoute feature="voiceover-script" component={VoiceoverScriptPage} />} />
        <Route path="/automated-shorts" component={() => <ProtectedRoute feature="automated-shorts" component={AutomatedShortsPage} />} />
        <Route path="/automated-shorts-no-voiceover" component={() => <ProtectedRoute feature="automated-shorts-no-voiceover" component={AutomatedShortsNoVoiceoverPage} />} />
        <Route path="/automated-shorts-factory" component={() => <ProtectedRoute feature="automated-shorts-factory" component={AutomatedShortsFactoryPage} />} />
        {/* Single consolidated settings page (admin). /settings kept as an alias. */}
        <Route path="/settings" component={() => <ProtectedRoute adminOnly component={AdminSettingsPage} />} />
        <Route path="/admin/settings" component={() => <ProtectedRoute adminOnly component={AdminSettingsPage} />} />
        <Route component={NotFound} />
      </Switch>
    </MainLayout>
  );
}

function AppRouter() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <AuthenticatedApp />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <AppRouter />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
