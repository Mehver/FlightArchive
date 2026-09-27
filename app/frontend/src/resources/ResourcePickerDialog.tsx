// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import { useMemo } from 'react';
import { useTranslation } from '../i18n';
import { scaled, useDialogScale } from '../utils/dialogScale';
import { isImageResource } from './resourcePaths';
import { ResourceBrowser } from './ResourceBrowser';
import { useResourceBrowser, type ResourceBrowserFilter } from './useResourceBrowser';

export interface ResourcePickerDialogProps {
  open: boolean;
  title: string;
  selected: string[];
  multiple?: boolean;
  imageOnly?: boolean;
  /** Restrict selection to pending inbox files while retaining the standard picker shell. */
  selectable?: 'all' | 'inbox';
  /** Optional caller-owned subset, used when a workflow may consume only inbox files. */
  allowedPaths?: readonly string[];
  onConfirm: (paths: string[]) => void;
  onClose: () => void;
}

/** Dialog shell retaining the original picker API; browsing state and UI live in the reusable module. */
export function ResourcePickerDialog({
  open, title, selected, multiple = false, imageOnly = false, selectable = 'all', allowedPaths, onConfirm, onClose,
}: ResourcePickerDialogProps) {
  const { t } = useTranslation();
  const dialogScale = useDialogScale();
  const filter = useMemo<ResourceBrowserFilter>(() => ({ entry, review }) =>
    (selectable === 'inbox'
      ? review.state === 'pending'
      : review.state === 'pending' || review.state === 'mapped' || review.uses.length > 0 || selected.includes(entry.virtual_path))
    && (!imageOnly || isImageResource(entry.virtual_path))
    && (!allowedPaths || allowedPaths.includes(entry.virtual_path)), [allowedPaths, imageOnly, selectable, selected]);
  const browser = useResourceBrowser({ active: open, initialSelected: selected, multiple, filter });

  return <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth aria-labelledby="resource-picker-dialog-title" slotProps={{ paper: { sx: { width: scaled(900, dialogScale), maxWidth: '95vw', maxHeight: '90vh' } } }}>
    <DialogTitle id="resource-picker-dialog-title">{title}</DialogTitle>
    <DialogContent dividers><ResourceBrowser browser={browser} label={title} multiple={multiple} /></DialogContent>
    <DialogActions>
      {!multiple ? <Box sx={{ mr: 'auto' }}><Button onClick={() => void browser.ignore()} disabled={!browser.canIgnore || browser.ignoring}>{browser.ignoring ? t('resourceIgnoring') : t('resourceIgnore')}</Button></Box> : null}
      <Button onClick={onClose}>{t('cancel')}</Button>
      <Button variant="contained" disabled={!browser.picked.length || browser.ignoring} onClick={() => onConfirm(browser.picked)}>{t('resourceSelect')}</Button>
    </DialogActions>
  </Dialog>;
}
