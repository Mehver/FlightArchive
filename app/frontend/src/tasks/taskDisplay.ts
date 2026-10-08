// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pure rendering helpers for static legacy fingerprint records.
 */

import type { TaskRecord, TaskState } from '../api/types';
import type { TranslationKey } from '../i18n';

/** Newest first by createdAt; ties break on id so the order is stable. The input array is not mutated. */
export function sortTasksNewestFirst(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => {
    const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
  });
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
