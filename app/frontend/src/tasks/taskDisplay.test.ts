// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization of the background-tasks page's pure display/state rules:
 * the poll cadence follows task activity (fast while queued/running, idle
 * otherwise), the list is newest-first with a stable tiebreak, progress is
 * clamped and indeterminate for non-positive totals, and every task state
 * has a deterministic color and label key.
 */

import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../api/types';
import {
  countTasksByState,
  isTaskActive,
  pollDelayMs,
  sortTasksNewestFirst,
  taskProgress,
  taskStateColor,
  taskStateKey,
} from './taskDisplay';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    kind: 'fingerprints',
    state: 'queued',
    createdAt: '2026-08-28T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    items: [],
    ...overrides,
  };
}

describe('isTaskActive', () => {
  it('treats queued and running as active, terminal states as inactive', () => {
    expect(isTaskActive({ state: 'queued' })).toBe(true);
    expect(isTaskActive({ state: 'running' })).toBe(true);
    expect(isTaskActive({ state: 'succeeded' })).toBe(false);
    expect(isTaskActive({ state: 'failed' })).toBe(false);
  });
});

describe('pollDelayMs', () => {
  it('polls fast while any task is queued or running', () => {
    expect(pollDelayMs([{ state: 'queued' }])).toBe(1000);
    expect(pollDelayMs([{ state: 'succeeded' }, { state: 'running' }])).toBe(1000);
  });

  it('polls slowly when the registry is empty or fully terminal', () => {
    expect(pollDelayMs([])).toBe(5000);
    expect(pollDelayMs([{ state: 'succeeded' }, { state: 'failed' }])).toBe(5000);
  });

  it('honours custom delays', () => {
    expect(pollDelayMs([{ state: 'running' }], 250, 2000)).toBe(250);
    expect(pollDelayMs([], 250, 2000)).toBe(2000);
  });
});

describe('sortTasksNewestFirst', () => {
  it('orders by createdAt descending without mutating the input', () => {
    const oldest = makeTask({ id: 'a', createdAt: '2026-08-28T08:00:00.000Z' });
    const newest = makeTask({ id: 'c', createdAt: '2026-08-28T12:00:00.000Z' });
    const middle = makeTask({ id: 'b', createdAt: '2026-08-28T10:00:00.000Z' });
    const input = [oldest, newest, middle];
    expect(sortTasksNewestFirst(input)).toEqual([newest, middle, oldest]);
    expect(input).toEqual([oldest, newest, middle]);
  });

  it('breaks createdAt ties on id so the order is stable', () => {
    const first = makeTask({ id: 'task-a' });
    const second = makeTask({ id: 'task-b' });
    expect(sortTasksNewestFirst([first, second])).toEqual([second, first]);
    expect(sortTasksNewestFirst([second, first])).toEqual([second, first]);
  });
});

describe('countTasksByState', () => {
  it('counts every state and derives the active total', () => {
    const counts = countTasksByState([
      makeTask({ id: '1', state: 'queued' }),
      makeTask({ id: '2', state: 'running' }),
      makeTask({ id: '3', state: 'running' }),
      makeTask({ id: '4', state: 'succeeded' }),
      makeTask({ id: '5', state: 'failed' }),
    ]);
    expect(counts).toEqual({ total: 5, active: 3, queued: 1, running: 2, succeeded: 1, failed: 1 });
  });

  it('reports zeros for an empty registry', () => {
    expect(countTasksByState([])).toEqual({ total: 0, active: 0, queued: 0, running: 0, succeeded: 0, failed: 0 });
  });
});

describe('taskProgress', () => {
  it('returns a clamped fraction of completed over total', () => {
    expect(taskProgress({ completed: 3, total: 6 })).toBe(0.5);
    expect(taskProgress({ completed: 9, total: 6 })).toBe(1);
    expect(taskProgress({ completed: -1, total: 6 })).toBe(0);
  });

  it('returns null for a non-positive or non-finite total (indeterminate)', () => {
    expect(taskProgress({ completed: 0, total: 0 })).toBeNull();
    expect(taskProgress({ completed: 1, total: -2 })).toBeNull();
    expect(taskProgress({ completed: 1, total: Number.NaN })).toBeNull();
  });
});

describe('taskStateColor / taskStateKey', () => {
  it('maps every state to a deterministic color', () => {
    expect(taskStateColor('queued')).toBe('default');
    expect(taskStateColor('running')).toBe('info');
    expect(taskStateColor('succeeded')).toBe('success');
    expect(taskStateColor('failed')).toBe('error');
  });

  it('maps every state to its label key', () => {
    expect(taskStateKey('queued')).toBe('taskStateQueued');
    expect(taskStateKey('running')).toBe('taskStateRunning');
    expect(taskStateKey('succeeded')).toBe('taskStateSucceeded');
    expect(taskStateKey('failed')).toBe('taskStateFailed');
  });
});
