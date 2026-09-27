// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, FormGroup, List, ListItem, ListItemText, Typography,
} from '@mui/material';
import type { HashAlgorithm } from '../rfg/api';
import { useTranslation } from '../i18n';
import { ResourceBrowser } from './ResourceBrowser';
import { useResourceBrowser, type ResourceBrowserFilter } from './useResourceBrowser';

export type AutoMatchAlgorithm = HashAlgorithm | 'filename' | 'sizeBytes';
const algorithms: AutoMatchAlgorithm[] = ['filename', 'sizeBytes', 'sha256', 'md5', 'crc32', 'phash'];

export interface AutoRematchDialogProps {
  open: boolean;
  targetPaths: readonly string[];
  initialCandidatePaths?: readonly string[];
  busy: boolean;
  onApply: (candidatePaths: string[], targetPaths: string[], algorithms: AutoMatchAlgorithm[]) => void;
  onClose: () => void;
}

/** Unified automatic-rematch shell: pending-file browser plus fixed targets and matching fields. */
export function AutoRematchDialog({
  open, targetPaths, initialCandidatePaths = [], busy, onApply, onClose,
}: AutoRematchDialogProps) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<AutoMatchAlgorithm[]>(['filename', 'sizeBytes']);
  const inboxOnly = useMemo<ResourceBrowserFilter>(() => ({ review }) => review.state === 'pending', []);
  const browser = useResourceBrowser({ active: open, initialSelected: initialCandidatePaths, multiple: true, filter: inboxOnly });

  useEffect(() => {
    if (open) setChosen(['filename', 'sizeBytes']);
  }, [open]);

  const toggleAlgorithm = (algorithm: AutoMatchAlgorithm) => setChosen((current) =>
    current.includes(algorithm) ? current.filter((item) => item !== algorithm) : [...current, algorithm]);

  return <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth aria-labelledby="auto-rematch-dialog-title">
    <DialogTitle id="auto-rematch-dialog-title">{t('batchRematchTitle')}</DialogTitle>
    <DialogContent dividers>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('batchRematchDescription')}</Typography>
      <ResourceBrowser browser={browser} label={t('batchRematchCandidates')} multiple />
      <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle2">{t('autoRematchTargets', { count: targetPaths.length })}</Typography>
        {!targetPaths.length ? <Alert severity="info" sx={{ mt: 1 }}>{t('rematchNoTargets')}</Alert> : (
          <List dense aria-label={t('rematchTarget')} sx={{ maxHeight: 112, overflow: 'auto', py: 0.5 }}>
            {targetPaths.map((path) => <ListItem key={path} disableGutters><ListItemText primary={path} slotProps={{ primary: { variant: 'caption', sx: { fontFamily: 'monospace', wordBreak: 'break-all' } } }} /></ListItem>)}
          </List>
        )}
        <Typography variant="subtitle2" sx={{ mt: 1 }}>{t('batchRematchAlgorithms')}</Typography>
        <FormGroup row sx={{ columnGap: 0.5 }}>
          {algorithms.map((algorithm) => <FormControlLabel key={algorithm} sx={{ mr: 1 }} control={<Checkbox size="small" disabled={busy} checked={chosen.includes(algorithm)} onChange={() => toggleAlgorithm(algorithm)} />} label={t(`batchRematchAlgorithm${algorithm[0].toUpperCase()}${algorithm.slice(1)}` as never)} />)}
        </FormGroup>
        <Typography variant="caption" color="text.secondary">{t('batchRematchUniqueHint')}</Typography>
      </Box>
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose} disabled={busy}>{t('cancel')}</Button>
      <Button variant="contained" disabled={busy || !browser.picked.length || !targetPaths.length || !chosen.length} onClick={() => onApply(browser.picked, [...targetPaths], chosen)}>{busy ? t('batchRematchWorking') : t('batchRematchApply')}</Button>
    </DialogActions>
  </Dialog>;
}
