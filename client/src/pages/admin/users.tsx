import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Users as UsersIcon, Trash2, Key, ToggleLeft, ToggleRight, Check, X, Clock, Mail, UserPlus } from "lucide-react";
import { ALL_FEATURES as FEATURE_KEYS, type FeatureKey } from "@shared/schema";

type UserRow = {
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
};

type AccessRequestRow = {
  id: number;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  createdAt: string;
};

const FEATURE_LABELS: Record<FeatureKey, string> = {
  "classic": "Auto-Shorts (Classic)",
  "automated-shorts": "Automated Shorts",
  "elevenlabs": "ElevenLabs",
  "download": "Download Video",
  "voiceover-script": "Voiceover Script",
};

const ALL_FEATURES = FEATURE_KEYS.map((key) => ({ key, label: FEATURE_LABELS[key] }));

export default function AdminUsersPage() {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [requests, setRequests] = useState<AccessRequestRow[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingPerms, setEditingPerms] = useState<number | null>(null);
  const [editPerms, setEditPerms] = useState<string[]>([]);

  // Create form
  const [newAuth, setNewAuth] = useState<"google" | "password">("google");
  const [newEmail, setNewEmail] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPerms, setNewPerms] = useState<string[]>(["automated-shorts"]);
  const [newUseAdminEL, setNewUseAdminEL] = useState(true);
  const [newUseAdminOR, setNewUseAdminOR] = useState(true);

  // Approve form
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [approvePerms, setApprovePerms] = useState<string[]>(["automated-shorts"]);

  const fetchData = async () => {
    const [uRes, rRes] = await Promise.all([
      fetch("/api/admin/users", { credentials: "include" }),
      fetch("/api/admin/access-requests", { credentials: "include" }),
    ]);
    if (uRes.ok) setUsers(await uRes.json());
    if (rRes.ok) setRequests(await rRes.json());
  };

  useEffect(() => { fetchData(); }, []);

  if (!isAdmin) return <div className="p-8 text-center text-muted-foreground">Admin access required</div>;

  const pendingRequests = requests.filter((r) => r.status === "pending");

  const handleCreate = async () => {
    const body: any = {
      displayName: newDisplayName,
      authMethod: newAuth,
      permissions: newPerms,
      useAdminElevenlabs: newUseAdminEL,
      useAdminOpenrouter: newUseAdminOR,
    };
    if (newAuth === "google") body.email = newEmail;
    else { body.username = newUsername; body.password = newPassword; }

    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (res.ok) {
      setShowCreate(false);
      setNewEmail(""); setNewUsername(""); setNewPassword(""); setNewDisplayName("");
      fetchData();
    } else {
      const err = await res.json();
      alert(err.error || "Failed to create user");
    }
  };

  const handleToggleActive = async (id: number, current: boolean) => {
    await fetch(`/api/admin/users/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !current }),
      credentials: "include",
    });
    fetchData();
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this user?")) return;
    await fetch(`/api/admin/users/${id}`, { method: "DELETE", credentials: "include" });
    fetchData();
  };

  const handleSavePerms = async (id: number) => {
    await fetch(`/api/admin/users/${id}/permissions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions: editPerms }),
      credentials: "include",
    });
    setEditingPerms(null);
    fetchData();
  };

  const handleApprove = async (id: number) => {
    await fetch(`/api/admin/access-requests/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions: approvePerms }),
      credentials: "include",
    });
    setApprovingId(null);
    fetchData();
  };

  const handleReject = async (id: number) => {
    await fetch(`/api/admin/access-requests/${id}/reject`, { method: "POST", credentials: "include" });
    fetchData();
  };

  const togglePerm = (perms: string[], perm: string, setter: (p: string[]) => void) => {
    setter(perms.includes(perm) ? perms.filter((p) => p !== perm) : [...perms, perm]);
  };

  const selectAll = (setter: (p: string[]) => void) => {
    setter(ALL_FEATURES.map((f) => f.key));
  };

  const PermCheckboxes = ({ perms, setter }: { perms: string[]; setter: (p: string[]) => void }) => (
    <div className="space-y-2">
      <button onClick={() => selectAll(setter)} className="text-xs text-primary hover:underline">Select all</button>
      <div className="grid grid-cols-2 gap-1">
        {ALL_FEATURES.map((f) => (
          <label key={f.key} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
            <input type="checkbox" checked={perms.includes(f.key)} onChange={() => togglePerm(perms, f.key, setter)} className="rounded" />
            {f.label}
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <UsersIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">User Management</h1>
            <p className="text-sm text-muted-foreground">{users.length} users total</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          Create User
        </button>
      </div>

      {/* Create User Form */}
      {showCreate && (
        <div className="bg-card border border-border rounded-xl p-6 space-y-4">
          <h3 className="font-semibold">Create New User</h3>
          <div className="flex gap-3">
            <button onClick={() => setNewAuth("google")} className={`px-3 py-1.5 rounded-lg text-xs ${newAuth === "google" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              <Mail className="w-3 h-3 inline mr-1" />Google Email
            </button>
            <button onClick={() => setNewAuth("password")} className={`px-3 py-1.5 rounded-lg text-xs ${newAuth === "password" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              <Key className="w-3 h-3 inline mr-1" />Username + Password
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Display Name *" value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} className="px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm col-span-2" />
            {newAuth === "google" ? (
              <input placeholder="Google Email *" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm col-span-2" />
            ) : (
              <>
                <input placeholder="Username *" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm" />
                <input placeholder="Password *" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm" />
              </>
            )}
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={newUseAdminEL} onChange={(e) => setNewUseAdminEL(e.target.checked)} /> Use admin ElevenLabs key</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={newUseAdminOR} onChange={(e) => setNewUseAdminOR(e.target.checked)} /> Use admin OpenRouter key</label>
          </div>
          <PermCheckboxes perms={newPerms} setter={setNewPerms} />
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg bg-muted text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Pending Access Requests */}
      {pendingRequests.length > 0 && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-6 space-y-4">
          <h3 className="font-semibold flex items-center gap-2 text-amber-500">
            <Clock className="w-4 h-4" />
            Pending Access Requests ({pendingRequests.length})
          </h3>
          {pendingRequests.map((req) => (
            <div key={req.id} className="flex items-center gap-4 bg-card border border-border rounded-lg p-4">
              {req.avatarUrl ? (
                <img src={req.avatarUrl} className="w-10 h-10 rounded-full" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-bold">
                  {(req.displayName || req.email)[0].toUpperCase()}
                </div>
              )}
              <div className="flex-1">
                <p className="text-sm font-medium">{req.displayName || req.email}</p>
                <p className="text-xs text-muted-foreground">{req.email}</p>
              </div>
              {approvingId === req.id ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium">Select permissions:</p>
                  <PermCheckboxes perms={approvePerms} setter={setApprovePerms} />
                  <div className="flex gap-2">
                    <button onClick={() => handleApprove(req.id)} className="px-3 py-1 rounded-lg bg-green-600 text-white text-xs">Approve</button>
                    <button onClick={() => setApprovingId(null)} className="px-3 py-1 rounded-lg bg-muted text-xs">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button onClick={() => { setApprovingId(req.id); setApprovePerms(["automated-shorts"]); }} className="px-3 py-1.5 rounded-lg bg-green-600/10 text-green-500 text-xs hover:bg-green-600/20">
                    <Check className="w-3 h-3 inline mr-1" />Approve
                  </button>
                  <button onClick={() => handleReject(req.id)} className="px-3 py-1.5 rounded-lg bg-destructive/10 text-destructive text-xs hover:bg-destructive/20">
                    <X className="w-3 h-3 inline mr-1" />Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Users Table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">User</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Auth</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Role</th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Permissions</th>
              <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={`border-b border-border/50 ${!u.isActive ? "opacity-50" : ""}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    {u.avatarUrl ? (
                      <img src={u.avatarUrl} className="w-8 h-8 rounded-full" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                        {u.displayName[0].toUpperCase()}
                      </div>
                    )}
                    <div>
                      <p className="text-sm font-medium">{u.displayName}</p>
                      <p className="text-[11px] text-muted-foreground">{u.email || u.username}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${u.authMethod === "google" ? "bg-blue-500/10 text-blue-500" : "bg-muted text-muted-foreground"}`}>
                    {u.authMethod}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${u.role === "admin" ? "bg-amber-500/10 text-amber-500" : "bg-muted text-muted-foreground"}`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {editingPerms === u.id ? (
                    <div className="space-y-2">
                      <PermCheckboxes perms={editPerms} setter={setEditPerms} />
                      <div className="flex gap-1">
                        <button onClick={() => handleSavePerms(u.id)} className="px-2 py-1 rounded bg-primary text-primary-foreground text-xs">Save</button>
                        <button onClick={() => setEditingPerms(null)} className="px-2 py-1 rounded bg-muted text-xs">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-xs text-muted-foreground">{u.role === "admin" ? "All" : u.permissions.length + " tools"}</span>
                      {u.role !== "admin" && (
                        <button onClick={() => { setEditingPerms(u.id); setEditPerms(u.permissions); }} className="text-[10px] text-primary hover:underline ml-1">edit</button>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {u.role !== "admin" && (
                      <>
                        <button onClick={() => handleToggleActive(u.id, u.isActive)} className="p-1.5 rounded-lg hover:bg-muted" title={u.isActive ? "Deactivate" : "Activate"}>
                          {u.isActive ? <ToggleRight className="w-4 h-4 text-green-500" /> : <ToggleLeft className="w-4 h-4 text-muted-foreground" />}
                        </button>
                        <button onClick={() => handleDelete(u.id)} className="p-1.5 rounded-lg hover:bg-destructive/10 text-destructive" title="Delete">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
