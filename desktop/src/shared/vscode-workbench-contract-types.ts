export type VscodeWorkbenchStatus =
  | "disabled"
  | "unavailable"
  | "ready"
  | "starting"
  | "running"
  | "failed";

export interface VscodeWorkbenchDiagnostics {
  status: VscodeWorkbenchStatus;
  enabled: boolean;
  runtimePath: string | null;
  runtimeExists: boolean;
  userDataPath: string | null;
  extensionsDir: string | null;
  logsDir: string | null;
  galleryEnabled: boolean;
  galleryServiceUrlHost: string | null;
  extensionHostKind: "node-workspace";
  extensionAutoUpdate: boolean;
  appAutoUpdate: boolean;
  fallbackToHanaOnFailure: boolean;
  message: string;
  lastError: string | null;
}
