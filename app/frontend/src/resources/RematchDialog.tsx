// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Controlled select → preview → apply rematch dialog, adapted from the
 * remappable-file-gateway demo's RematchModal but deliberately narrowed:
 *
 * - exactly one missing classified target + one inbox candidate;
 * - the target virtual path is static text and always preserved — no
 *   virtual-path editing, no raw map editing, no create/delete/batch;
 * - apply goes through the FlightArchive business endpoint
 *   (POST /api/resources/rematches), never a direct RFG map PUT.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { MappingEntry } from '../rfg/api';
import { useTranslation } from '../i18n';
import { ResourceImage } from './ResourceImage';
import { scaled, useDialogScale } from '../utils/dialogScale';

const IMAGE_EXTENSIONS = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' } as const;

export interface RematchDialogError {
  message: string;
  conflict: boolean;
}

export function RematchDialog({
  open,
  targets,
  candidates,
  initialTarget,
  applying,
  error,
  onApply,
  onClose,
}: {
  open: boolean;
  /** Missing classified entries (virtual paths preserved). */
  targets: MappingEntry[];
  /** Current inbox entries whose local file is present. */
  candidates: MappingEntry[];
  /** Preselected target virtual path (e.g. from a row action). */
  initialTarget: string | null;
  applying: boolean;
  error: RematchDialogError | null;
  onApply: (targetVirtualPath: string, candidateInboxVirtualPath: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogScale = useDialogScale();
  const [targetPath, setTargetPath] = useState('');
  const [candidatePath, setCandidatePath] = useState('');

  useEffect(() => {
    if (open) {
      setTargetPath(initialTarget ?? '');
      setCandidatePath('');
    }
  }, [open, initialTarget]);

  // A reload (e.g. after a concurrency conflict) can drop the reviewed rows;
  // never keep a selection that no longer exists.
  useEffect(() => {
    setTargetPath((current) => (current && !targets.some((entry) => entry.virtual_path === current) ? '' : current));
  }, [targets]);
  useEffect(() => {
    setCandidatePath((current) => (current && !candidates.some((entry) => entry.virtual_path === current) ? '' : current));
  }, [candidates]);

  const target = useMemo(() => targets.find((entry) => entry.virtual_path === targetPath) ?? null, [targets, targetPath]);
  const candidate = useMemo(
    () => candidates.find((entry) => entry.virtual_path === candidatePath) ?? null,
    [candidates, candidatePath],
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="rematch-dialog-title" slotProps={{ paper: { sx: { width: scaled(600, dialogScale), maxWidth: '95vw' } } }}>
      <DialogTitle id="rematch-dialog-title">{t('rematchTitle')}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('rematchDescription')}
        </Typography>
        {error ? (
          <Alert severity={error.conflict ? 'warning' : 'error'} sx={{ mb: 2 }} role="alert">
            {error.message}
          </Alert>
        ) : null}

        <TextField
          select
          fullWidth
          margin="dense"
          label={t('rematchTarget')}
          value={targetPath}
          onChange={(event) => setTargetPath(event.target.value)}
          disabled={targets.length === 0}
          helperText={targets.length === 0 ? t('rematchNoTargets') : t('rematchTargetHint')}
        >
          {targets.map((entry) => (
            <MenuItem key={entry.virtual_path} value={entry.virtual_path}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={MONO}>
                  {entry.virtual_path}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ ...MONO, display: 'block' }} noWrap>
                  {t('rematchLastKnown')}: {entry.local_path}
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          fullWidth
          margin="dense"
          label={t('rematchCandidate')}
          value={candidatePath}
          onChange={(event) => setCandidatePath(event.target.value)}
          disabled={candidates.length === 0}
          helperText={candidates.length === 0 ? t('rematchNoCandidates') : t('rematchCandidateHint')}
          sx={{ mt: 2 }}
        >
          {candidates.map((entry) => (
            <MenuItem key={entry.virtual_path} value={entry.virtual_path}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={MONO}>
                  {entry.virtual_path}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ ...MONO, display: 'block' }} noWrap>
                  {entry.local_path}
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </TextField>

        {target && candidate ? (
          <Paper variant="outlined" sx={{ p: 2, mt: 2.5 }} aria-live="polite">
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 650, display: 'block', mb: 1 }}>
              {t('rematchPreview')}
            </Typography>
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
              {IMAGE_EXTENSIONS.test(candidate.virtual_path) ? (
                <ResourceImage resourcePath={candidate.virtual_path} size={72} alt={candidate.virtual_path} contain />
              ) : null}
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                  <LockOutlinedIcon fontSize="small" color="primary" aria-hidden />
                  <Typography variant="body2" sx={MONO}>
                    {target.virtual_path}
                  </Typography>
                  <Chip size="small" color="primary" variant="outlined" label={t('rematchPreserved')} />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, my: 0.5, color: 'text.secondary' }}>
                  <ArrowDownwardIcon fontSize="small" aria-hidden />
                  <Typography variant="caption">{t('rematchNewSource')}</Typography>
                </Box>
                <Typography variant="body2" sx={MONO}>
                  {candidate.local_path}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  {t('rematchPreviewNote')}
                </Typography>
              </Box>
            </Box>
          </Paper>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={!target || !candidate || applying}
          onClick={() => target && candidate && onApply(target.virtual_path, candidate.virtual_path)}
        >
          {applying ? t('rematchApplying') : t('rematchApply')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
