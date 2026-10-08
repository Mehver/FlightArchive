// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Characterization of the static legacy-record rendering rules.
 */

import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../api/types';
import {
  sortTasksNewestFirst,
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
    const first = makeTask({ id: 'task-20260828T100000000000Z-aaaaaaaa' });
    const second = makeTask({ id: 'task-20260828T100000000001Z-bbbbbbbb' });
    expect(sortTasksNewestFirst([first, second])).toEqual([second, first]);
    expect(sortTasksNewestFirst([second, first])).toEqual([second, first]);
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
