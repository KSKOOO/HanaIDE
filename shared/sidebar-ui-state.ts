export interface SidebarUiProjectViewPrefs {
  collapsedProjectIds: string[];
  collapsedFolderIds: string[];
  showAllProjectIds: string[];
}

export interface SidebarUiPrefs {
  projectView: SidebarUiProjectViewPrefs;
}

const MAX_IDS = 256;
const MAX_ID_LENGTH = 240;

function cleanId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return "";
  return trimmed;
}

function uniqueIds(values: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(values) ? values : []) {
    const id = cleanId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

export function normalizeSidebarUiPrefs(raw: unknown = {}): SidebarUiPrefs {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const projectView = source.projectView && typeof source.projectView === "object" && !Array.isArray(source.projectView)
    ? (source.projectView as Record<string, unknown>)
    : {};
  return {
    projectView: {
      collapsedProjectIds: uniqueIds(projectView.collapsedProjectIds),
      collapsedFolderIds: uniqueIds(projectView.collapsedFolderIds),
      showAllProjectIds: uniqueIds(projectView.showAllProjectIds),
    },
  };
}

export function mergeSidebarUiPrefs(current: unknown = {}, partial: unknown = {}): SidebarUiPrefs {
  const base = normalizeSidebarUiPrefs(current);
  const patch = partial && typeof partial === "object" && !Array.isArray(partial) ? (partial as Record<string, unknown>) : {};
  const patchProjectView = patch.projectView && typeof patch.projectView === "object" && !Array.isArray(patch.projectView)
    ? (patch.projectView as Record<string, unknown>)
    : {};
  const nextProjectView: Record<string, string[]> = { ...base.projectView };
  for (const key of ["collapsedProjectIds", "collapsedFolderIds", "showAllProjectIds"] as const) {
    if (Object.prototype.hasOwnProperty.call(patchProjectView, key)) {
      nextProjectView[key] = uniqueIds(patchProjectView[key]);
    }
  }
  return normalizeSidebarUiPrefs({ projectView: nextProjectView });
}
