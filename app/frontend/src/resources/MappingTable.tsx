// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { ReactNode } from 'react';
import {
  Box, ButtonBase, Chip, IconButton, Paper, Table, TableBody, TableCell,
  TableContainer, TableHead, TableSortLabel, type ChipProps, type TableCellProps,
} from '@mui/material';
import NorthEastIcon from '@mui/icons-material/NorthEast';
import SouthEastIcon from '@mui/icons-material/SouthEast';
import type { MappingRowKind } from './mappingRows';
import { basename, middleEllipsisPath } from './resourcePaths';

export type MappingPathDisplayMode = 0 | 1 | 2;

export function formatMappingPath(path: string, mode: MappingPathDisplayMode): string {
  if (mode === 0) return path;
  return mode === 1 ? basename(path) : middleEllipsisPath(path);
}

export function mappingStatusColor(kind: MappingRowKind): ChipProps['color'] {
  if (kind === 'missing') return 'error';
  if (kind === 'inbox') return 'warning';
  if (kind === 'paired') return 'success';
  return 'default';
}

export function MappingStatusChip({ kind, label }: {
  kind: MappingRowKind;
  label: ReactNode;
}) {
  return <Chip size="small" variant="outlined" color={mappingStatusColor(kind)} label={label} />;
}

export function MappingHeaderCell({
  children, sortDimension, active = false, direction = 'asc', onLabelClick,
  onDirectionClick, directionAriaLabel, pathDisplay, ...cellProps
}: Omit<TableCellProps, 'sortDirection'> & {
  sortDimension?: 'first' | 'second';
  active?: boolean;
  direction?: 'asc' | 'desc';
  onLabelClick?: () => void;
  onDirectionClick?: () => void;
  directionAriaLabel?: string;
  pathDisplay?: {
    mode: MappingPathDisplayMode;
    onCycle: () => void;
    ariaLabel: string;
  };
}) {
  const sortable = Boolean(sortDimension && onLabelClick && onDirectionClick);
  const controlsVisible = active;
  return <TableCell {...cellProps} sortDirection={sortable && active ? direction : false} sx={{ whiteSpace: 'nowrap', fontWeight: 600, color: 'text.secondary', ...cellProps.sx, '&:hover .MappingHeader-controls, &:focus-within .MappingHeader-controls': { opacity: 1 } }}>
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
      {onLabelClick ? (
        <ButtonBase onClick={onLabelClick} sx={{ color: 'inherit', font: 'inherit', textAlign: 'left' }}>
          {children}
        </ButtonBase>
      ) : children}
      {sortable ? (
        <Box className="MappingHeader-controls" sx={{ display: 'inline-flex', alignItems: 'center', opacity: controlsVisible ? 1 : 0, transition: 'opacity 120ms' }}>
          {sortDimension === 'second' ? (
            <TableSortLabel
              active
              direction={direction}
              hideSortIcon={false}
              onClick={onDirectionClick}
              aria-label={directionAriaLabel}
              sx={{ p: 0.25, '& .MuiTableSortLabel-icon': { m: 0 } }}
            />
          ) : (
            <IconButton size="small" onClick={onDirectionClick} aria-label={directionAriaLabel}>
              {direction === 'asc' ? <NorthEastIcon fontSize="inherit" /> : <SouthEastIcon fontSize="inherit" />}
            </IconButton>
          )}
          {pathDisplay ? (
            <IconButton size="small" onClick={pathDisplay.onCycle} aria-label={pathDisplay.ariaLabel} sx={{ fontSize: '0.875rem' }}>
              {(['①', '②', '③'] as const)[pathDisplay.mode]}
            </IconButton>
          ) : null}
        </Box>
      ) : null}
    </Box>
  </TableCell>;
}

export function MappingRowActions({ children }: { children: ReactNode }) {
  return <Box sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5, whiteSpace: 'nowrap' }}>{children}</Box>;
}

export function MappingTable({ label, header, children }: {
  label: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
    <Table size="small" aria-label={label}>
      <TableHead>{header}</TableHead>
      <TableBody>{children}</TableBody>
    </Table>
  </TableContainer>;
}
