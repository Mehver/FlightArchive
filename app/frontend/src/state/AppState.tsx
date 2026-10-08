// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Shared application state: status heartbeat, frontend-owned catalogs, and
 * the compatibility surface for feedback.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api/client';
import type { Catalogs } from '../api/types';
import { BusinessDataProvider, useBusinessData } from '../domain/BusinessDataProvider';
import { useWorkspaceHeartbeat, type ConnectivityState } from './useWorkspaceHeartbeat';
import { FeedbackProvider, useFeedback, type FeedbackContext, type FeedbackSeverity } from '../feedback/FeedbackCenter';

interface AppStateValue {
  connectivity: ConnectivityState;
  recheckConnection: () => Promise<void>;
  catalogs: Catalogs | null;
  refreshAll: () => Promise<void>;
  notify: (message: string, severity?: FeedbackSeverity, context?: FeedbackContext) => void;
  showError: (error: unknown, fallback?: string, context?: FeedbackContext) => void;
  observedActivityRevision: string | null;
  lastReadActivityRevision: string | null;
  hasUnreadActivity: boolean;
  markActivityRead: (revision: string | null) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

function AppStateProviderInner({ children }: { children: ReactNode }) {
  const { notify, showError } = useFeedback();
  const { data } = useBusinessData();
  const { connectivity, status, recheck: recheckConnection } = useWorkspaceHeartbeat(api.status);
  const [lastReadActivityRevision, setLastReadActivityRevision] = useState<string | null>(null);
  const observedActivityRevision = status?.activityRevision ?? null;
  const hasUnreadActivity = observedActivityRevision !== null && observedActivityRevision !== lastReadActivityRevision;
  const markActivityRead = useCallback((revision: string | null) => {
    setLastReadActivityRevision(revision);
  }, []);
  const catalogs = useMemo<Catalogs | null>(() => data ? ({
    airlines: data.airlines,
    airports: data.airports,
    aircraftTypes: data.aircraftTypes,
  }) : null, [data]);

  const refreshAll = useCallback(async () => {
    await recheckConnection();
  }, [recheckConnection]);

  const value = useMemo<AppStateValue>(
    () => ({
      connectivity,
      recheckConnection,
      catalogs,
      refreshAll,
      notify,
      showError,
      observedActivityRevision,
      lastReadActivityRevision,
      hasUnreadActivity,
      markActivityRead,
    }),
    [connectivity, recheckConnection, catalogs, refreshAll, notify, showError, observedActivityRevision, lastReadActivityRevision, hasUnreadActivity, markActivityRead],
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
  return (
    <FeedbackProvider>
      <BusinessDataProvider><AppStateProviderInner>{children}</AppStateProviderInner></BusinessDataProvider>
    </FeedbackProvider>
  );
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside AppStateProvider');
  return value;
}
