// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Three independent read-only streams: this session, saved activity, and legacy fingerprint records. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Button, Chip, CircularProgress, Collapse, Divider, IconButton, Paper, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import ScheduleIcon from '@mui/icons-material/Schedule';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { api } from '../api/client';
import type { ActivityDay, ActivityRecord, TaskDay, TaskItemRecord, TaskRecord, TaskState } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useTranslation, type TranslationKey } from '../i18n';
import { ALGORITHM_LABEL, RESULT_CODE_KEY } from '../resources/FingerprintDialog';
import { useFeedback, type FeedbackRecord } from '../feedback/FeedbackCenter';
import { sortTasksNewestFirst, taskStateColor, taskStateKey, type TaskStateColor } from './taskDisplay';

const PAGE_SIZE_DAYS = 3;
const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } as const;
const CHIP_COMPACT = { height: 20, fontSize: '0.65rem' } as const;
const STATE_BORDER: Record<TaskStateColor, string> = { default: 'divider', info: 'info.main', success: 'success.main', error: 'error.main' };
const ACTIVITY_CODE_KEYS: Partial<Record<string, TranslationKey>> = {
  'v1-to-v2-failed': 'activityMigrationFailed',
  'v1-to-v2-committed': 'activityMigrationCommitted',
  'v1-to-v2-failed-fallback-seeded': 'activityMigrationFallbackSeeded',
  'archive-document-save-failed': 'activityArchiveSaveFailed',
  'archive-prepared-commit-failed': 'activityArchiveSaveFailed',
  'archive-prepared-rollback-failed': 'activityArchiveRestoreFailed',
  'resource-mapping-failed': 'activityMappingFailed',
  'resource-fingerprint-failed': 'activityFingerprintFailed',
  'resource-coordination-failed': 'activityResourceCoordinationFailed',
  'resource-coordination-compensation-failed': 'resourceCompensationFailed',
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function formatLogDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

function mergeTaskDays(current: readonly TaskDay[], incoming: readonly TaskDay[]): TaskDay[] {
  const byDate = new Map<string, Map<string, TaskRecord>>();
  for (const day of [...current, ...incoming]) {
    const records = byDate.get(day.date) ?? new Map<string, TaskRecord>();
    for (const task of day.tasks) records.set(task.id, task);
    byDate.set(day.date, records);
  }
  return [...byDate.entries()].sort(([left], [right]) => right.localeCompare(left))
    .map(([date, records]) => ({ date, tasks: sortTasksNewestFirst([...records.values()]) }));
}

function mergeActivityDays(current: readonly ActivityDay[], incoming: readonly ActivityDay[]): ActivityDay[] {
  const byDate = new Map<string, Map<string, ActivityRecord>>();
  for (const day of [...current, ...incoming]) {
    const records = byDate.get(day.date) ?? new Map<string, ActivityRecord>();
    for (const activity of day.activities) records.set(activity.id, activity);
    byDate.set(day.date, records);
  }
  return [...byDate.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([date, records]) => ({
    date,
    activities: [...records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  }));
}

function ItemStateIcon({ state }: { state: TaskState }) {
  if (state === 'succeeded') return <CheckCircleIcon sx={{ fontSize: 16, display: 'block' }} color="success" aria-hidden />;
  if (state === 'failed') return <HighlightOffIcon sx={{ fontSize: 16, display: 'block' }} color="error" aria-hidden />;
  return <ScheduleIcon sx={{ fontSize: 16, display: 'block' }} color={state === 'running' ? 'info' : 'disabled'} aria-hidden />;
}

function TaskItemRow({ item }: { item: TaskItemRecord }) {
  const { t } = useTranslation();
  const codeKey = item.code ? RESULT_CODE_KEY[item.code] : undefined;
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 0.5, flexWrap: 'wrap' }}>
      <Box sx={{ pt: '1px', flexShrink: 0 }}><ItemStateIcon state={item.state} /></Box>
      <Typography variant="caption" sx={{ ...MONO, wordBreak: 'break-all', flex: '1 1 180px' }}>{item.virtualPath}</Typography>
      <Chip size="small" variant="outlined" label={ALGORITHM_LABEL[item.algorithm]} sx={{ ...CHIP_COMPACT, fontFamily: MONO.fontFamily }} />
      {item.state === 'failed' ? (
        <Typography variant="caption" color="error" sx={{ flexBasis: '100%', pl: 3 }}>
          {codeKey ? `${t(codeKey)} (${item.code ?? ''})` : item.code}{item.message ? ` — ${item.message}` : ''}
        </Typography>
      ) : null}
    </Box>
  );
}

function TaskCard({ task }: { task: TaskRecord }) {
  const { t } = useTranslation();
  const color = taskStateColor(task.state);
  const [expanded, setExpanded] = useState(false);
  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.25, sm: 1.5 }, borderLeft: 4, borderLeftColor: STATE_BORDER[color] }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Chip size="small" color={color} variant="outlined" label={t(taskStateKey(task.state))} />
        <Typography variant="body2" sx={{ fontWeight: 650 }}>{t('taskKindFingerprints')}</Typography>
        <Typography variant="caption" color="text.disabled" sx={{ ...MONO, flex: '1 1 auto', minWidth: 0 }} noWrap title={task.id}>{task.id}</Typography>
        <Button size="small" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}
          endIcon={<ExpandMoreIcon sx={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />}>
          {t('taskItems', { count: task.items.length })}
        </Button>
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 0.5 }}>
        <Typography variant="caption" color="text.secondary" component="time" dateTime={task.createdAt}>{t('taskCreated', { time: formatTimestamp(task.createdAt) })}</Typography>
        {task.startedAt ? <Typography variant="caption" color="text.secondary">{t('taskStarted', { time: formatTimestamp(task.startedAt) })}</Typography> : null}
        {task.finishedAt ? <Typography variant="caption" color="text.secondary">{t('taskFinished', { time: formatTimestamp(task.finishedAt) })}</Typography> : null}
        <Typography variant="caption" color={task.failed ? 'error' : 'text.secondary'}>{t('taskResults', { succeeded: task.succeeded, failed: task.failed })}</Typography>
        <Typography variant="caption" color="text.secondary">{task.completed}/{task.total}</Typography>
      </Box>
      <Collapse in={expanded} unmountOnExit><Divider sx={{ my: 1 }} />{task.items.map((item) => <TaskItemRow key={`${item.virtualPath}${item.algorithm}`} item={item} />)}</Collapse>
    </Paper>
  );
}

function SessionCard({ record }: { record: FeedbackRecord }) {
  const { t } = useTranslation();
  const failed = record.finalState === 'failed';
  const context = [record.context?.action, record.context?.resource, record.context?.form].filter(Boolean);
  return (
    <Paper variant="outlined" data-testid="activity-record" sx={{ p: 1.5, borderLeft: 4, borderLeftColor: failed ? 'error.main' : 'success.main' }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        {failed ? <HighlightOffIcon color="error" aria-hidden /> : <InfoOutlinedIcon color={record.severity === 'warning' ? 'warning' : 'info'} aria-hidden />}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Chip size="small" color={failed ? 'error' : record.severity === 'warning' ? 'warning' : 'success'} variant="outlined" label={t(failed ? 'feedbackStateFailed' : 'feedbackStateSucceeded')} />
          <Typography variant="body2" sx={{ fontWeight: 650, mt: 0.5 }}>{record.message}</Typography>
          {context.length ? <Typography variant="caption" color="text.secondary">{context.join(' · ')}</Typography> : null}
          <Typography variant="caption" color="text.disabled" component="time" dateTime={record.createdAt} sx={{ display: 'block' }}>{formatTimestamp(record.createdAt)}</Typography>
        </Box>
      </Box>
    </Paper>
  );
}

function readableDetails(details: ActivityRecord['details']): string {
  if (typeof details === 'string') return details;
  return JSON.stringify(details, null, 2);
}

function SavedActivityCard({ record }: { record: ActivityRecord }) {
  const { t } = useTranslation();
  const severe = record.severity === 'error';
  const warning = record.severity === 'warning';
  const messageKey = ACTIVITY_CODE_KEYS[record.code];
  const message = messageKey ? t(messageKey) : record.code;
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderLeft: 4, borderLeftColor: severe ? 'error.main' : warning ? 'warning.main' : 'info.main' }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        {severe ? <HighlightOffIcon color="error" aria-hidden /> : warning ? <WarningAmberIcon color="warning" aria-hidden /> : <InfoOutlinedIcon color="info" aria-hidden />}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{message}</Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, my: 0.75 }}>
            <Chip size="small" variant="outlined" color={severe ? 'error' : warning ? 'warning' : 'info'} label={record.severity} />
            <Chip size="small" variant="outlined" label={record.source} />
            <Chip size="small" variant="outlined" label={record.kind} />
            <Chip size="small" variant="outlined" label={record.state} />
          </Box>
          <Typography variant="caption" sx={{ ...MONO, display: 'block', wordBreak: 'break-all' }}>{record.code}</Typography>
          <Typography variant="caption" color="text.disabled" component="time" dateTime={record.createdAt}>{formatTimestamp(record.createdAt)}</Typography>
          {record.details !== null ? (
            <Box component="details" sx={{ mt: 0.75 }}>
              <Typography component="summary" variant="caption" sx={{ cursor: 'pointer' }}>{t('activityDetails')}</Typography>
              <Typography component="pre" variant="caption" sx={{ ...MONO, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', m: 0.5 }}>{readableDetails(record.details)}</Typography>
            </Box>
          ) : null}
        </Box>
      </Box>
    </Paper>
  );
}

export function TasksPage({ onClose, observedActivityRevision, onActivityRead }: {
  onClose?: () => void;
  observedActivityRevision?: string | null;
  onActivityRead?: (revision: string | null) => void;
}) {
  const { t } = useTranslation();
  const { records } = useFeedback();
  const [activityDays, setActivityDays] = useState<ActivityDay[] | null>(null);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [activityMore, setActivityMore] = useState(false);
  const [activityFailed, setActivityFailed] = useState(false);
  const [activityLoadingMore, setActivityLoadingMore] = useState(false);
  const [taskDays, setTaskDays] = useState<TaskDay[] | null>(null);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [taskMore, setTaskMore] = useState(false);
  const [tasksFailed, setTasksFailed] = useState(false);
  const [tasksLoadingMore, setTasksLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const activityController = useRef<AbortController | null>(null);
  const taskController = useRef<AbortController | null>(null);
  const activitySentinel = useRef<HTMLDivElement | null>(null);
  const taskSentinel = useRef<HTMLDivElement | null>(null);
  const activityBusy = useRef(false);
  const taskBusy = useRef(false);
  const revisionRef = useRef(observedActivityRevision);

  const loadLatestActivity = useCallback(async () => {
    if (!mounted.current || activityBusy.current) return false;
    activityBusy.current = true;
    const controller = new AbortController();
    activityController.current?.abort(); activityController.current = controller;
    try {
      const page = await api.listActivity({ limitDays: PAGE_SIZE_DAYS }, controller.signal);
      if (!mounted.current) return false;
      setActivityDays((current) => mergeActivityDays(current ?? [], page.days));
      setActivityCursor(page.nextCursor); setActivityMore(page.hasMore); setActivityFailed(false);
      onActivityRead?.(page.revision);
      return true;
    } catch {
      if (mounted.current && !controller.signal.aborted) setActivityFailed(true);
      return false;
    } finally {
      if (activityController.current === controller) activityController.current = null;
      activityBusy.current = false;
    }
  }, [onActivityRead]);

  const loadLatestTasks = useCallback(async () => {
    if (!mounted.current || taskBusy.current) return false;
    taskBusy.current = true;
    const controller = new AbortController();
    taskController.current?.abort(); taskController.current = controller;
    try {
      const page = await api.listTasks({ limitDays: PAGE_SIZE_DAYS }, controller.signal);
      if (!mounted.current) return false;
      setTaskDays((current) => mergeTaskDays(current ?? [], page.days));
      setTaskCursor(page.nextCursor); setTaskMore(page.hasMore); setTasksFailed(false);
      return true;
    } catch {
      if (mounted.current && !controller.signal.aborted) setTasksFailed(true);
      return false;
    } finally {
      if (taskController.current === controller) taskController.current = null;
      taskBusy.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadLatestActivity(); void loadLatestTasks();
    return () => { mounted.current = false; activityController.current?.abort(); taskController.current?.abort(); };
  }, [loadLatestActivity, loadLatestTasks]);

  useEffect(() => {
    if (revisionRef.current === observedActivityRevision) return;
    revisionRef.current = observedActivityRevision;
    if (observedActivityRevision !== undefined) void loadLatestActivity();
  }, [observedActivityRevision, loadLatestActivity]);

  const loadOlderActivity = useCallback(async () => {
    if (!mounted.current || activityBusy.current || !activityMore || !activityCursor) return;
    activityBusy.current = true; setActivityLoadingMore(true);
    const controller = new AbortController(); activityController.current = controller;
    try {
      const page = await api.listActivity({ before: activityCursor, limitDays: PAGE_SIZE_DAYS }, controller.signal);
      if (!mounted.current) return;
      setActivityDays((current) => mergeActivityDays(current ?? [], page.days));
      setActivityCursor(page.nextCursor); setActivityMore(page.hasMore); setActivityFailed(false);
    } catch { if (mounted.current && !controller.signal.aborted) setActivityFailed(true); }
    finally { activityBusy.current = false; if (mounted.current) setActivityLoadingMore(false); }
  }, [activityCursor, activityMore]);

  const loadOlderTasks = useCallback(async () => {
    if (!mounted.current || taskBusy.current || !taskMore || !taskCursor) return;
    taskBusy.current = true; setTasksLoadingMore(true);
    const controller = new AbortController(); taskController.current = controller;
    try {
      const page = await api.listTasks({ before: taskCursor, limitDays: PAGE_SIZE_DAYS }, controller.signal);
      if (!mounted.current) return;
      setTaskDays((current) => mergeTaskDays(current ?? [], page.days));
      setTaskCursor(page.nextCursor); setTaskMore(page.hasMore); setTasksFailed(false);
    } catch { if (mounted.current && !controller.signal.aborted) setTasksFailed(true); }
    finally { taskBusy.current = false; if (mounted.current) setTasksLoadingMore(false); }
  }, [taskCursor, taskMore]);

  useEffect(() => {
    const target = activitySentinel.current;
    if (!target || !activityMore || !activityCursor) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadOlderActivity(); }, { rootMargin: '160px 0px' });
    observer.observe(target); return () => observer.disconnect();
  }, [activityCursor, activityMore, loadOlderActivity]);
  useEffect(() => {
    const target = taskSentinel.current;
    if (!target || !taskMore || !taskCursor) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadOlderTasks(); }, { rootMargin: '160px 0px' });
    observer.observe(target); return () => observer.disconnect();
  }, [taskCursor, taskMore, loadOlderTasks]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadLatestActivity(), loadLatestTasks()]);
    if (mounted.current) setRefreshing(false);
  }, [loadLatestActivity, loadLatestTasks]);
  const activities = useMemo(() => (activityDays ?? []).flatMap((day) => day.activities), [activityDays]);
  const tasks = useMemo(() => (taskDays ?? []).flatMap((day) => day.tasks), [taskDays]);

  return (
    <Box>
      <PageHeader title={t('feedbackCenter')} actions={<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Button variant="outlined" startIcon={refreshing ? <CircularProgress size={16} aria-hidden /> : <RefreshIcon />} onClick={() => void refresh()} disabled={refreshing}>{t('tasksRefresh')}</Button>
        {onClose ? <IconButton aria-label={t('close')} onClick={onClose}><CloseIcon /></IconButton> : null}
      </Box>} />

      <Box component="section" sx={{ mb: 2.5 }}>
        <Typography component="h2" variant="subtitle2" sx={{ mb: 1 }}>{t('feedbackSessionActivity')}</Typography>
        {records.length ? <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>{records.map((record) => <SessionCard key={record.id} record={record} />)}</Box>
          : <EmptyState title={t('activitySessionEmpty')} />}
      </Box>

      <Box component="section" sx={{ mb: 2.5 }}>
        <Typography component="h2" variant="subtitle2" sx={{ mb: 1 }}>{t('activitySaved')}</Typography>
        {activityDays === null && !activityFailed ? <LoadingState label={t('activityLoading')} /> : null}
        {activityFailed ? <ErrorState message={t('activityLoadFailed')} onRetry={() => void loadLatestActivity()} /> : null}
        {activityDays !== null && activities.length === 0 ? <EmptyState title={t('activityEmpty')} /> : null}
        {(activityDays ?? []).map((day) => <Box component="section" key={day.date} sx={{ mb: 2 }}>
          <Typography component="h3" variant="subtitle1" sx={{ mb: 1, fontWeight: 700 }}>{formatLogDay(day.date)}</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>{day.activities.map((record) => <SavedActivityCard key={record.id} record={record} />)}</Box>
        </Box>)}
        <Box ref={activitySentinel} data-testid="activity-load-more-sentinel" sx={{ minHeight: 1, textAlign: 'center' }}>
          {activityLoadingMore ? <CircularProgress size={20} aria-label={t('activityLoadingMore')} /> : null}
        </Box>
      </Box>

      <Box component="section">
        <Typography component="h2" variant="subtitle2" sx={{ mb: 1 }}>{t('tasksLegacy')}</Typography>
        {taskDays === null && !tasksFailed ? <LoadingState label={t('tasksLoading')} /> : null}
        {tasksFailed ? <ErrorState message={t('tasksLoadFailed')} onRetry={() => void loadLatestTasks()} /> : null}
        {taskDays !== null && tasks.length === 0 ? <EmptyState title={t('tasksEmpty')} /> : null}
        {(taskDays ?? []).map((day) => <Box component="section" key={day.date} sx={{ mb: 2 }}>
          <Typography component="h3" variant="subtitle1" sx={{ mb: 1, fontWeight: 700 }}>{formatLogDay(day.date)}</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>{day.tasks.map((task) => <TaskCard key={task.id} task={task} />)}</Box>
        </Box>)}
        <Box ref={taskSentinel} data-testid="tasks-load-more-sentinel" sx={{ minHeight: 1, textAlign: 'center' }}>
          {tasksLoadingMore ? <CircularProgress size={20} aria-label={t('tasksLoadingMore')} /> : null}
        </Box>
      </Box>
    </Box>
  );
}
