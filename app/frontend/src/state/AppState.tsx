// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Shared application state: status heartbeat, explicitly refreshed catalogs,
 * and the compatibility surface for feedback. The heartbeat observes reachability only; mutation
 * responses are authoritative and their callers refresh relevant data after
 * success. Business data is never periodically synchronized.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api/client';
import type { Catalogs } from '../api/types';
import { useWorkspaceHeartbeat, type ConnectivityState } from './useWorkspaceHeartbeat';
import { FeedbackProvider, useFeedback, type FeedbackContext, type FeedbackSeverity } from '../feedback/FeedbackCenter';

interface AppStateValue {
  connectivity: ConnectivityState;
  recheckConnection: () => Promise<void>;
  catalogs: Catalogs | null;
  refreshCatalogs: () => Promise<void>;
  refreshAll: () => Promise<void>;
  notify: (message: string, severity?: FeedbackSeverity, context?: FeedbackContext) => void;
  showError: (error: unknown, fallback?: string, context?: FeedbackContext) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

function AppStateProviderInner({ children }: { children: ReactNode }) {
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const { notify, showError } = useFeedback();
  const { connectivity, recheck: recheckConnection } = useWorkspaceHeartbeat(api.status);

  const refreshCatalogs = useCallback(async () => {
    try {
      setCatalogs(await api.getCatalogs());
    } catch {
      /* catalogs stay stale; status bar already signals backend issues */
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([recheckConnection(), refreshCatalogs()]);
  }, [recheckConnection, refreshCatalogs]);

  // Catalogs are loaded once for consumers; unlike the heartbeat this is not
  // a recurring sync. Mutations retain responsibility for targeted refreshes.
  useEffect(() => { void refreshCatalogs(); }, [refreshCatalogs]);

  const value = useMemo<AppStateValue>(
    () => ({
      connectivity,
      recheckConnection,
      catalogs,
      refreshCatalogs,
      refreshAll,
      notify,
      showError,
    }),
    [connectivity, recheckConnection, catalogs, refreshCatalogs, refreshAll, notify, showError],
  );

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  );
}

/** Includes exactly one feedback host so legacy AppState consumers and new
 * useFeedback consumers share records rather than rendering duplicate toasts. */
export function AppStateProvider({ children }: { children: ReactNode }) {
  return <FeedbackProvider><AppStateProviderInner>{children}</AppStateProviderInner></FeedbackProvider>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside AppStateProvider');
  return value;
}
