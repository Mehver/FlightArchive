// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TableCell, TableRow } from '@mui/material';
import { formatMappingPath, MappingHeaderCell, MappingStatusChip, MappingTable, mappingStatusColor } from './MappingTable';

afterEach(cleanup);

describe('mappingStatusColor', () => {
  it('keeps one semantic color convention for every mapping state', () => {
    expect((['paired', 'inbox', 'ignored', 'missing'] as const).map((kind) => [kind, mappingStatusColor(kind)])).toEqual([
      ['paired', 'success'],
      ['inbox', 'warning'],
      ['ignored', 'default'],
      ['missing', 'error'],
    ]);
  });
});

it('formats all three independent path display modes', () => {
  expect(formatMappingPath('objects/trips/ticket.png', 0)).toBe('objects/trips/ticket.png');
  expect(formatMappingPath('objects/trips/ticket.png', 1)).toBe('ticket.png');
  expect(formatMappingPath('objects/trips/ticket.png', 2)).toBe('objects/…/ticket.png');
  expect(formatMappingPath('ticket.png', 2)).toBe('ticket.png');
});

it('renders separate label, direction, and path-display controls', () => {
  const onLabel = vi.fn(), onDirection = vi.fn(), onCycle = vi.fn();
  render(<MappingTable label="Mappings" header={<TableRow><MappingHeaderCell sortDimension="second" active direction="desc" onLabelClick={onLabel} onDirectionClick={onDirection} directionAriaLabel="Sort Resource Path descending" pathDisplay={{ mode: 1, onCycle, ariaLabel: 'Resource Path display mode 2' }}>Resource Path</MappingHeaderCell></TableRow>}>
    <TableRow><TableCell><MappingStatusChip kind="missing" label="Missing" /></TableCell></TableRow>
  </MappingTable>);

  expect(screen.getByRole('table', { name: 'Mappings' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Resource Path' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sort Resource Path descending' }));
  fireEvent.click(screen.getByRole('button', { name: 'Resource Path display mode 2' }));
  expect(onLabel).toHaveBeenCalledOnce();
  expect(onDirection).toHaveBeenCalledOnce();
  expect(onCycle).toHaveBeenCalledOnce();
  expect(screen.getByText('Missing').closest('.MuiChip-root')?.className).toContain('MuiChip-colorError');
});
