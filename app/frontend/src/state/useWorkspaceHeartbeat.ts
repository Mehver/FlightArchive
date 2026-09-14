// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceStatus } from '../api/types';

export type ConnectivityState = 'checking' | 'online' | 'offline';

interface StatusResponse {
  status: WorkspaceStatus;
}

export interface WorkspaceHeartbeat {
  connectivity: ConnectivityState;
  status: WorkspaceStatus | null;
  recheck: () => Promise<void>;
}

/** The cheap status endpoint is the only periodically synchronized API. */
export function useWorkspaceHeartbeat(
  checkStatus: (signal?: AbortSignal) => Promise<StatusResponse>,
  intervalMs = 30_000,
): WorkspaceHeartbeat {
  const [connectivity, setConnectivity] = useState<ConnectivityState>('checking');
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const checkStatusRef = useRef(checkStatus);
  checkStatusRef.current = checkStatus;
  const recheckRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    let mounted = true;
    let sequence = 0;
    let controller: AbortController | null = null;

    const check = async (foreground: boolean) => {
      controller?.abort();
      controller = new AbortController();
      const request = ++sequence;
      // Polling retains its current visible state so a healthy connection does
      // not flicker every 30 seconds; explicit checks communicate activity.
      if (foreground && mounted) setConnectivity('checking');
      try {
        const response = await checkStatusRef.current(controller.signal);
        if (mounted && request === sequence) {
          setStatus(response.status);
          setConnectivity('online');
        }
      } catch {
        if (mounted && request === sequence) setConnectivity('offline');
      }
    };

    recheckRef.current = () => check(true);
    void check(true);
    const timer = window.setInterval(() => { void check(false); }, intervalMs);
    return () => {
      mounted = false;
      ++sequence;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  const recheck = useCallback(() => recheckRef.current(), []);
  return { connectivity, status, recheck };
}
