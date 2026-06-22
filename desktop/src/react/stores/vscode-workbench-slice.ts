import type { VscodeWorkbenchDiagnostics } from '../../shared/vscode-workbench-contract-types';

export interface VscodeWorkbenchSlice {
  vscodeWorkbenchStatus: VscodeWorkbenchDiagnostics | null;
  vscodeWorkbenchLoading: boolean;
  vscodeWorkbenchError: string | null;
  setVscodeWorkbenchStatus: (status: VscodeWorkbenchDiagnostics | null) => void;
  setVscodeWorkbenchLoading: (loading: boolean) => void;
  setVscodeWorkbenchError: (error: string | null) => void;
}

export const createVscodeWorkbenchSlice = (
  set: (partial: Partial<VscodeWorkbenchSlice>) => void,
): VscodeWorkbenchSlice => ({
  vscodeWorkbenchStatus: null,
  vscodeWorkbenchLoading: false,
  vscodeWorkbenchError: null,
  setVscodeWorkbenchStatus: (status) => set({ vscodeWorkbenchStatus: status }),
  setVscodeWorkbenchLoading: (loading) => set({ vscodeWorkbenchLoading: loading }),
  setVscodeWorkbenchError: (error) => set({ vscodeWorkbenchError: error }),
});
