// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pure display/state helpers for the background-tasks page. The backend
 * (GET /api/tasks) is authoritative; these helpers only decide poll cadence,
 * ordering, counts, progress and status coloring for the read-only view.
 */

import type { TaskRecord, TaskState } from '../api/types';
import type { TranslationKey } from '../i18n';

/** A task that still has work ahead of it drives the fast poll cadence. */
export function isTaskActive(task: Pick<TaskRecord, 'state'>): boolean {
  return task.state === 'queued' || task.state === 'running';
}

/**
 * Poll cadence: fast (activeMs) while any task is queued/running so progress
 * feels live; slow (idleMs) once everything reached a terminal state. An
 * empty registry is idle.
 */
export function pollDelayMs(
  tasks: readonly Pick<TaskRecord, 'state'>[],
  activeMs = 1000,
  idleMs = 5000,
): number {
  return tasks.some(isTaskActive) ? activeMs : idleMs;
}

/** Newest first by createdAt; ties break on id so the order is stable. The input array is not mutated. */
export function sortTasksNewestFirst(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => {
    const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
  });
}

export interface TaskStateCounts {
  total: number;
  active: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
}

/** Header count summary across all tasks currently in the registry. */
export function countTasksByState(tasks: readonly TaskRecord[]): TaskStateCounts {
  const counts: TaskStateCounts = { total: tasks.length, active: 0, queued: 0, running: 0, succeeded: 0, failed: 0 };
  for (const task of tasks) {
    counts[task.state] += 1;
    if (isTaskActive(task)) counts.active += 1;
  }
  return counts;
}

/**
 * Determinate progress fraction in [0, 1], or null when the total is not
 * positive (the progress bar then renders indeterminate).
 */
export function taskProgress(task: Pick<TaskRecord, 'completed' | 'total'>): number | null {
  if (!Number.isFinite(task.total) || task.total <= 0) return null;
  return Math.min(1, Math.max(0, task.completed / task.total));
}

export type TaskStateColor = 'default' | 'info' | 'success' | 'error';

/** MUI color for a task/item state: queued is neutral, running is informational. */
export function taskStateColor(state: TaskState): TaskStateColor {
  switch (state) {
    case 'running':
      return 'info';
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'error';
    default:
      return 'default';
  }
}

/** i18n key for a task/item state label. */
export function taskStateKey(state: TaskState): TranslationKey {
  switch (state) {
    case 'queued':
      return 'taskStateQueued';
    case 'running':
      return 'taskStateRunning';
    case 'succeeded':
      return 'taskStateSucceeded';
    case 'failed':
      return 'taskStateFailed';
  }
}
