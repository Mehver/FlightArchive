// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Background tasks page: a read-only, polled status view (GET /api/tasks).
 * This page never mutates or clears tasks.
 *
 * Polling is a single chained timeout (never an interval), so requests can
 * never overlap or waterfall: while any task is queued/running the cadence
 * is 1 s, otherwise 5 s. The timer is cancelled when the page unmounts
 * (e.g. on navigation). A manual refresh cancels the scheduled cycle and
 * requests a fresh snapshot when no request is already in flight.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { api } from '../api/client';
import type { TaskItemRecord, TaskRecord, TaskState } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useTranslation } from '../i18n';
import { ALGORITHM_LABEL, RESULT_CODE_KEY } from '../resources/FingerprintDialog';
import {
  countTasksByState,
  isTaskActive,
  pollDelayMs,
  sortTasksNewestFirst,
  taskProgress,
  taskStateColor,
  taskStateKey,
  type TaskStateColor,
} from './taskDisplay';

const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 5000;
const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } as const;
const CHIP_COMPACT = { height: 20, fontSize: '0.65rem' } as const;
/** Status-colored card edge, keyed by the same color scale as the chips. */
const STATE_BORDER: Record<TaskStateColor, string> = {
  default: 'divider',
  info: 'info.main',
  success: 'success.main',
  error: 'error.main',
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ItemStateIcon({ state }: { state: TaskState }) {
  switch (state) {
    case 'running':
      return <CircularProgress size={14} aria-hidden />;
    case 'succeeded':
      return <CheckCircleIcon sx={{ fontSize: 16, display: 'block' }} color="success" aria-hidden />;
    case 'failed':
      return <HighlightOffIcon sx={{ fontSize: 16, display: 'block' }} color="error" aria-hidden />;
    default:
      return <ScheduleIcon sx={{ fontSize: 16, display: 'block' }} color="disabled" aria-hidden />;
  }
}

function TaskItemRow({ item }: { item: TaskItemRecord }) {
  const { t } = useTranslation();
  const failed = item.state === 'failed';
  const codeKey = item.code ? RESULT_CODE_KEY[item.code] : undefined;
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 0.5, flexWrap: 'wrap' }}>
      <Box sx={{ pt: '1px', flexShrink: 0 }}>
        <ItemStateIcon state={item.state} />
      </Box>
      <Typography variant="caption" sx={{ ...MONO, wordBreak: 'break-all', flex: '1 1 180px' }}>
        {item.virtualPath}
      </Typography>
      <Chip
        size="small"
        variant="outlined"
        label={ALGORITHM_LABEL[item.algorithm]}
        sx={{ ...CHIP_COMPACT, fontFamily: MONO.fontFamily, flexShrink: 0 }}
      />
      {failed ? (
        <Typography variant="caption" color="error" sx={{ flexBasis: '100%', pl: 3 }}>
          {codeKey ? `${t(codeKey)} (${item.code ?? ''})` : item.code}
          {item.message ? ` — ${item.message}` : ''}
        </Typography>
      ) : null}
    </Box>
  );
}

function TaskCard({ task }: { task: TaskRecord }) {
  const { t } = useTranslation();
  const active = isTaskActive(task);
  const color = taskStateColor(task.state);
  const progress = taskProgress(task);
  // Finished tasks stay inspectable but collapse by default to keep the
  // list compact; active tasks start expanded so live progress is visible.
  const [expanded, setExpanded] = useState(active);
  return (
    <Paper
      variant="outlined"
      sx={{ p: { xs: 1.25, sm: 1.5 }, borderLeft: 4, borderLeftColor: STATE_BORDER[color] }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Chip size="small" color={color} variant="outlined" label={t(taskStateKey(task.state))} />
        <Typography variant="body2" sx={{ fontWeight: 650 }}>
          {t('taskKindFingerprints')}
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ ...MONO, flex: '1 1 auto', minWidth: 0 }} noWrap title={task.id}>
          {task.id}
        </Typography>
        <Button
          size="small"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          endIcon={
            <ExpandMoreIcon
              sx={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
            />
          }
          sx={{ flexShrink: 0, ml: 'auto' }}
        >
          {t('taskItems', { count: task.items.length })}
        </Button>
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 0.5 }}>
        <Typography variant="caption" color="text.secondary" component="time" dateTime={task.createdAt}>
          {t('taskCreated', { time: formatTimestamp(task.createdAt) })}
        </Typography>
        {task.startedAt ? (
          <Typography variant="caption" color="text.secondary" component="time" dateTime={task.startedAt}>
            {t('taskStarted', { time: formatTimestamp(task.startedAt) })}
          </Typography>
        ) : null}
        {task.finishedAt ? (
          <Typography variant="caption" color="text.secondary" component="time" dateTime={task.finishedAt}>
            {t('taskFinished', { time: formatTimestamp(task.finishedAt) })}
          </Typography>
        ) : null}
        <Typography variant="caption" color={task.failed > 0 ? 'error' : 'text.secondary'}>
          {t('taskResults', { succeeded: task.succeeded, failed: task.failed })}
        </Typography>
      </Box>
      {active ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 1 }}>
          <LinearProgress
            sx={{ flex: 1 }}
            variant={progress === null ? 'indeterminate' : 'determinate'}
            value={progress === null ? undefined : progress * 100}
            color={color === 'default' ? 'primary' : color}
            aria-label={t(taskStateKey(task.state))}
          />
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {task.completed}/{task.total}
          </Typography>
        </Box>
      ) : null}
      <Collapse in={expanded} unmountOnExit>
        <Divider sx={{ my: 1 }} />
        <Box>
          {task.items.map((item) => (
            <TaskItemRow key={`${item.virtualPath}${item.algorithm}`} item={item} />
          ))}
        </Box>
      </Collapse>
    </Paper>
  );
}

export function TasksPage({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** One poll cycle: fetch once, then schedule the next cycle from the fresh
   *  state. Re-entrant safe — a second call while a request is in flight is
   *  a no-op, so polling and manual refresh can never waterfall. */
  const poll = useCallback(async () => {
    if (inFlightRef.current || !mountedRef.current) return;
    inFlightRef.current = true;
    try {
      const { tasks: next } = await api.listTasks();
      if (!mountedRef.current) return;
      setTasks(next);
      setLoadFailed(false);
      setUpdatedAt(new Date().toISOString());
      clearTimer();
      timerRef.current = setTimeout(() => void poll(), pollDelayMs(next, ACTIVE_POLL_MS, IDLE_POLL_MS));
    } catch {
      if (!mountedRef.current) return;
      // Keep already-loaded tasks visible on a transient failure; the page
      // falls back to the idle cadence and flags the stale snapshot.
      setLoadFailed(true);
      clearTimer();
      timerRef.current = setTimeout(() => void poll(), IDLE_POLL_MS);
    } finally {
      inFlightRef.current = false;
    }
  }, [clearTimer]);

  useEffect(() => {
    mountedRef.current = true;
    void poll();
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [poll, clearTimer]);

  const refresh = useCallback(async () => {
    clearTimer();
    setRefreshing(true);
    try {
      await poll();
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [clearTimer, poll]);

  const ordered = useMemo(() => sortTasksNewestFirst(tasks ?? []), [tasks]);
  const counts = useMemo(() => countTasksByState(ordered), [ordered]);
  const summaryStates: readonly TaskState[] = ['running', 'queued', 'failed', 'succeeded'];

  return (
    <Box>
      <PageHeader
        title={t('tasks')}
        actions={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Button
              variant="outlined"
              startIcon={refreshing ? <CircularProgress size={16} aria-hidden /> : <RefreshIcon />}
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {t('tasksRefresh')}
            </Button>
            {onClose ? (
              <IconButton aria-label={t('close')} onClick={onClose}>
                <CloseIcon />
              </IconButton>
            ) : null}
          </Box>
        }
      />
      {tasks === null && loadFailed ? (
        <ErrorState message={t('tasksLoadFailed')} onRetry={() => void refresh()} />
      ) : tasks === null ? (
        <LoadingState label={t('tasksLoading')} />
      ) : ordered.length === 0 ? (
        <EmptyState title={t('tasksEmpty')} />
      ) : (
        <>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {t('tasksCount', { count: counts.total })}
            </Typography>
            {summaryStates
              .filter((state) => counts[state] > 0)
              .map((state) => (
                <Chip
                  key={state}
                  size="small"
                  variant="outlined"
                  color={taskStateColor(state)}
                  label={`${t(taskStateKey(state))} ${counts[state]}`}
                />
              ))}
            {loadFailed ? (
              <Typography variant="caption" color="error">
                {t('tasksLoadFailed')}
              </Typography>
            ) : null}
            {updatedAt ? (
              <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto' }}>
                {t('tasksLastUpdated', { time: formatTimestamp(updatedAt) })}
              </Typography>
            ) : null}
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }} aria-live="polite">
            {ordered.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}
