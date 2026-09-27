// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert, Snackbar } from '@mui/material';
import { ApiError } from '../api/client';
import { useTranslation } from '../i18n';

export type FeedbackSeverity = 'success' | 'info' | 'warning' | 'error';
export type FeedbackFinalState = 'succeeded' | 'failed';

export interface FeedbackContext {
  /** Short user-facing operation, for example “Save flight”. */
  action?: string;
  /** Relevant resource identifier or path. */
  resource?: string;
  /** Form or module where the operation originated. */
  form?: string;
}

export interface FeedbackRecord {
  /** Timestamp-prefixed session id, suitable for future log correlation. */
  id: string;
  createdAt: string;
  message: string;
  severity: FeedbackSeverity;
  finalState: FeedbackFinalState;
  context?: FeedbackContext;
  code?: string;
}

export interface FeedbackInput {
  message: string;
  severity?: FeedbackSeverity;
  context?: FeedbackContext;
  code?: string;
}

interface FeedbackValue {
  records: readonly FeedbackRecord[];
  feedback: (input: FeedbackInput) => FeedbackRecord;
  notify: (message: string, severity?: FeedbackSeverity, context?: FeedbackContext) => FeedbackRecord;
  showError: (error: unknown, fallback?: string, context?: FeedbackContext) => FeedbackRecord;
}

const FeedbackContextValue = createContext<FeedbackValue | null>(null);
const MAX_RECORDS = 200;

/** Owns the single session activity stream and the single transient toast host. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<FeedbackRecord[]>([]);
  const [toast, setToast] = useState<FeedbackRecord | null>(null);
  const sequence = useRef(0);

  const feedback = useCallback((input: FeedbackInput) => {
    const createdAt = new Date().toISOString();
    sequence.current += 1;
    const severity = input.severity ?? 'success';
    const record: FeedbackRecord = {
      id: `${createdAt}-${sequence.current.toString().padStart(4, '0')}`,
      createdAt,
      message: input.message,
      severity,
      finalState: severity === 'error' ? 'failed' : 'succeeded',
      context: input.context,
      code: input.code,
    };
    setRecords((current) => [record, ...current].slice(0, MAX_RECORDS));
    setToast(record);
    return record;
  }, []);

  const notify = useCallback(
    (message: string, severity: FeedbackSeverity = 'success', context?: FeedbackContext) =>
      feedback({ message, severity, context }),
    [feedback],
  );

  const showError = useCallback((error: unknown, fallback?: string, context?: FeedbackContext) => {
    const localizedFallback = fallback ?? t('operationFailed');
    if (error instanceof ApiError && error.code === 'resource-committed-refresh-failed') {
      return feedback({
        message: t('resourceCommittedRefreshFailed'),
        severity: 'error',
        context,
        code: error.code,
      });
    }
    if (error instanceof ApiError) {
      const message = error.code === 'network'
        ? t('apiNetworkUnavailable')
        : error.httpStatus > 0
          ? `${localizedFallback} (${t('apiRequestFailed', { status: error.httpStatus })})`
          : localizedFallback;
      const detail = Array.isArray(error.details) ? t('apiDetails', { count: error.details.length }) : '';
      return feedback({ message: `${message}${detail}`, severity: 'error', context, code: error.code });
    }
    return feedback({ message: localizedFallback, severity: 'error', context });
  }, [feedback, t]);

  const value = useMemo<FeedbackValue>(() => ({ records, feedback, notify, showError }), [records, feedback, notify, showError]);
  return (
    <FeedbackContextValue.Provider value={value}>
      {children}
      <Snackbar
        key={toast?.id ?? 'empty'}
        open={toast !== null}
        autoHideDuration={toast?.severity === 'error' ? 8000 : 4000}
        onClose={() => setToast((current) => current?.id === toast?.id ? null : current)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert key={toast.id} variant="filled" severity={toast.severity} onClose={() => setToast((current) => current?.id === toast.id ? null : current)}>
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </FeedbackContextValue.Provider>
  );
}

export function useFeedback(): FeedbackValue {
  const value = useContext(FeedbackContextValue);
  if (!value) throw new Error('useFeedback must be used inside FeedbackProvider');
  return value;
}
