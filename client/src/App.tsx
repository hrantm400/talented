import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import SmartCrop from "@/pages/smart-crop";
import AutoDucking from "@/pages/auto-ducking";
import Highlights from "@/pages/highlights";
import ColorGrade from "@/pages/color-grade";
import VocalIsolate from "@/pages/vocal-isolate";
import MotionTrack from "@/pages/motion-track";
import StyleStudio from "@/pages/style-studio";
import ViralCombo from "@/pages/combos/viral";
import PodcastCombo from "@/pages/combos/podcast";
import ActionCombo from "@/pages/combos/action";
import CinematicCombo from "@/pages/combos/cinematic";
import MemeCombo from "@/pages/combos/meme";
import ElevenLabsPage from "@/pages/elevenlabs";
import DownloadPage from "@/pages/download";
import VoiceoverScriptPage from "@/pages/voiceover-script";
import AutomatedShortsPage from "@/pages/automated-shorts";
import SettingsPage from "@/pages/settings";
import LoginPage from "@/pages/login";
import AdminUsersPage from "@/pages/admin/users";
import AdminSettingsPage from "@/pages/admin/settings";
import { MainLayout } from "@/components/layout";
import { Loader2 } from "lucide-react";

function ProtectedRoute({ feature, component: Component }: { feature?: string; component: React.ComponentType }) {
  const { hasFeature } = useAuth();
  if (feature && !hasFeature(feature)) {
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
        <Route path="/settings" component={SettingsPage} />
        <Route path="/smart-crop" component={() => <ProtectedRoute feature="smart-crop" component={SmartCrop} />} />
        <Route path="/auto-ducking" component={() => <ProtectedRoute feature="auto-ducking" component={AutoDucking} />} />
        <Route path="/highlights" component={() => <ProtectedRoute feature="highlights" component={Highlights} />} />
        <Route path="/color-grade" component={() => <ProtectedRoute feature="color-grade" component={ColorGrade} />} />
        <Route path="/vocal-isolate" component={() => <ProtectedRoute feature="vocal-isolate" component={VocalIsolate} />} />
        <Route path="/motion-track" component={() => <ProtectedRoute feature="motion-track" component={MotionTrack} />} />
        <Route path="/style-studio" component={() => <ProtectedRoute feature="style-studio" component={StyleStudio} />} />
        <Route path="/combos/viral" component={() => <ProtectedRoute feature="combos" component={ViralCombo} />} />
        <Route path="/combos/podcast" component={() => <ProtectedRoute feature="combos" component={PodcastCombo} />} />
        <Route path="/combos/action" component={() => <ProtectedRoute feature="combos" component={ActionCombo} />} />
        <Route path="/combos/cinematic" component={() => <ProtectedRoute feature="combos" component={CinematicCombo} />} />
        <Route path="/combos/meme" component={() => <ProtectedRoute feature="combos" component={MemeCombo} />} />
        {/* Admin routes */}
        <Route path="/admin/users" component={() => <ProtectedRoute component={AdminUsersPage} />} />
        <Route path="/admin/settings" component={() => <ProtectedRoute component={AdminSettingsPage} />} />
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
