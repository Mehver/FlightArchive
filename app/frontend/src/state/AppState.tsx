// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Shared application state: status heartbeat, explicitly refreshed catalogs,
 * and notifications. The heartbeat observes reachability only; mutation
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
import { Alert, Snackbar } from '@mui/material';
import { api, ApiError } from '../api/client';
import type { Catalogs, WorkspaceStatus } from '../api/types';
import { useTranslation } from '../i18n';
import { useWorkspaceHeartbeat, type ConnectivityState } from './useWorkspaceHeartbeat';

export type NotifySeverity = 'success' | 'info' | 'warning' | 'error';

interface AppStateValue {
  status: WorkspaceStatus | null;
  statusError: string | null;
  connectivity: ConnectivityState;
  recheckConnection: () => Promise<void>;
  catalogs: Catalogs | null;
  refreshStatus: () => Promise<void>;
  refreshCatalogs: () => Promise<void>;
  refreshAll: () => Promise<void>;
  notify: (message: string, severity?: NotifySeverity) => void;
  showError: (error: unknown, fallback?: string) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [snackbar, setSnackbar] = useState<{ message: string; severity: NotifySeverity } | null>(null);

  const notify = useCallback((message: string, severity: NotifySeverity = 'success') => {
    setSnackbar({ message, severity });
  }, []);
  const { status, connectivity, recheck: recheckConnection } = useWorkspaceHeartbeat(api.status);
  const statusError = connectivity === 'offline' ? t('backendUnreachable') : null;

  const showError = useCallback(
      (error: unknown, fallback?: string) => {
       const localizedFallback = fallback ?? t('operationFailed');
       if (error instanceof ApiError) {
          const message = error.code === 'network'
            ? t('apiNetworkUnavailable')
            : error.httpStatus > 0
              ? `${localizedFallback} (${t('apiRequestFailed', { status: error.httpStatus })})`
              : localizedFallback;
         const detail = Array.isArray(error.details) ? t('apiDetails', { count: error.details.length }) : '';
         notify(`${message}${detail}`, 'error');
      } else if (error instanceof Error) {
        notify(localizedFallback, 'error');
      } else {
        notify(localizedFallback, 'error');
      }
    },
    [notify, t],
  );

  const refreshStatus = recheckConnection;

  const refreshCatalogs = useCallback(async () => {
    try {
      setCatalogs(await api.getCatalogs());
    } catch {
      /* catalogs stay stale; status bar already signals backend issues */
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshCatalogs()]);
  }, [refreshStatus, refreshCatalogs]);

  // Catalogs are loaded once for consumers; unlike the heartbeat this is not
  // a recurring sync. Mutations retain responsibility for targeted refreshes.
  useEffect(() => { void refreshCatalogs(); }, [refreshCatalogs]);

  const value = useMemo<AppStateValue>(
    () => ({
      status,
      statusError,
      connectivity,
      recheckConnection,
      catalogs,
      refreshStatus,
      refreshCatalogs,
      refreshAll,
      notify,
      showError,
    }),
    [status, statusError, connectivity, recheckConnection, catalogs, refreshStatus, refreshCatalogs, refreshAll, notify, showError],
  );

  return (
    <AppStateContext.Provider value={value}>
      {children}
      <Snackbar
        open={snackbar !== null}
        autoHideDuration={snackbar?.severity === 'error' ? 8000 : 4000}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snackbar ? (
          <Alert variant="filled" severity={snackbar.severity} onClose={() => setSnackbar(null)}>
            {snackbar.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside AppStateProvider');
  return value;
}
