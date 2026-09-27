// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Controlled fingerprint dialog, inspired by the remappable-file-gateway
 * demo's hash workflow but narrowed to FlightArchive's business rule: only
 * object resources bound to persisted flights (boarding passes and attachments)
 * or airline logos can be fingerprinted, and successful values are persisted
 * onto their RFG mapping entries by the backend — never by the browser.
 *
 * The dialog is fully controlled: the parent owns enqueueing, busy state and
 * errors (including 409 ETag conflicts); the task drawer owns terminal status.
 * The dialog
 * only owns the algorithm selection, and derives the concrete target list
 * at calculate time from the latest props so a background reload can never
 * resurrect a stale selection. Pending inbox files are not fingerprint
 * eligible until materialized and bound to a persisted business record, so they
 * are never offered here.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import { HASH_ALGORITHMS, PERCEPTUAL_ALGORITHMS, type HashAlgorithm, type MappingEntry } from '../rfg/api';
import { useTranslation, type TranslationKey } from '../i18n';
import { supportsPerceptualFingerprint, targetsMissingAlgorithms, type FingerprintTarget } from './fingerprints';
import { scaled, useDialogScale } from '../utils/dialogScale';
import { SearchHighlight } from './SearchHighlight';

const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' } as const;

/** Language-neutral labels; algorithm names are protocol vocabulary.
 *  Shared with the background-tasks page, which renders the same items. */
export const ALGORITHM_LABEL: Record<HashAlgorithm, string> = {
  crc32: 'CRC-32',
  md5: 'MD5',
  sha256: 'SHA-256',
  ahash: 'aHash',
  dhash: 'dHash',
  phash: 'pHash',
};

/** Known terminal fingerprint failure codes → i18n keys. Shared with the
 *  background-tasks page, whose task items carry the same code vocabulary. */
export const RESULT_CODE_KEY: Partial<Record<string, TranslationKey>> = {
  source_stale: 'fingerprintCodeSourceStale',
  changed_during_hash: 'fingerprintCodeChangedDuringHash',
  unsupported_image: 'fingerprintCodeUnsupportedImage',
  image_too_large: 'fingerprintCodeImageTooLarge',
  hash_failed: 'fingerprintCodeHashFailed',
  capacity_exceeded: 'fingerprintCodeCapacity',
  rfg_unavailable: 'fingerprintCodeRfgUnavailable',
  'rfg-unavailable': 'fingerprintCodeRfgUnavailable',
  'resource-conflict': 'fingerprintCodeResourceConflict',
  'resource-not-eligible': 'fingerprintCodeResourceNotEligible',
  'resource-not-found': 'fingerprintCodeResourceNotFound',
  task_error: 'fingerprintCodeTaskError',
  task_interrupted: 'fingerprintCodeTaskInterrupted',
};

const CHIP_COMPACT = { height: 20, fontSize: '0.65rem' } as const;

/** Compact six-algorithm presence indicator for one mapping entry. */
export function HashPresenceChips({ entry, storedAlgorithms, localPath = entry.local_path, highlightQuery }: { entry: MappingEntry; storedAlgorithms?: readonly HashAlgorithm[]; localPath?: string; /** Optional mapping-table search query. */ highlightQuery?: string }) {
  const { t } = useTranslation();
  return (
    <Box component="span" sx={{ display: 'inline-flex', flexWrap: 'wrap', gap: 0.5 }}>
      {HASH_ALGORITHMS.map((algorithm) => {
        const value = entry[algorithm];
        const stored = storedAlgorithms?.includes(algorithm) ?? (typeof value === 'string' && value.length > 0);
        const applicable = !PERCEPTUAL_ALGORITHMS.includes(algorithm) || supportsPerceptualFingerprint(localPath);
        return (
          <Tooltip key={algorithm} title={!applicable ? t('fingerprintNotApplicable') : stored ? (value || t('fingerprintStored')) : t('fingerprintNotStored')}>
            <Chip
              size="small"
              variant={stored ? 'filled' : 'outlined'}
              color={stored ? 'success' : 'default'}
              label={<SearchHighlight text={ALGORITHM_LABEL[algorithm]} query={highlightQuery} />}
              sx={{
                ...CHIP_COMPACT,
                fontFamily: MONO.fontFamily,
                ...(!applicable || !stored ? { color: 'text.disabled', borderColor: 'divider' } : {}),
              }}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}

export function FingerprintDialog({
  open,
  targets,
  busy,
  error,
  onCalculate,
  onClose,
}: {
  open: boolean;
  /** Eligible targets resolved from the latest rows. */
  targets: FingerprintTarget[];
  busy: boolean;
  error: string | null;
  onCalculate: (virtualPaths: string[], algorithms: HashAlgorithm[], forceOverwrite: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogScale = useDialogScale();
  const [chosen, setChosen] = useState<ReadonlySet<HashAlgorithm>>(() => new Set(HASH_ALGORITHMS));
  const [forceOverwrite, setForceOverwrite] = useState(false);

  useEffect(() => {
    if (open) {
      setChosen(new Set(HASH_ALGORITHMS.filter((algorithm) => targets.some((target) => target.supported.includes(algorithm)))));
      setForceOverwrite(false);
    }
  }, [open, targets]);

  const selected = useMemo(() => HASH_ALGORITHMS.filter((algorithm) => chosen.has(algorithm)), [chosen]);
  // Incremental calculation is the default for both one and many targets.
  const eligible = useMemo(
    () => (forceOverwrite ? targets : targetsMissingAlgorithms(targets, selected)),
    [forceOverwrite, targets, selected],
  );

  const toggle = (algorithm: HashAlgorithm) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(algorithm)) next.delete(algorithm);
      else next.add(algorithm);
      return next;
    });

  const algorithmGroup = (algorithms: readonly HashAlgorithm[]) => (
    <FormGroup row>
      {algorithms.map((algorithm) => (
        <FormControlLabel
          key={algorithm}
          control={
            <Checkbox
              size="small"
              checked={chosen.has(algorithm)}
              onChange={() => toggle(algorithm)}
              disabled={busy || (PERCEPTUAL_ALGORITHMS.includes(algorithm) && !targets.some((target) => target.supported.includes(algorithm)))}
            />
          }
          label={<Typography variant="body2" sx={MONO}>{ALGORITHM_LABEL[algorithm]}</Typography>}
        />
      ))}
    </FormGroup>
  );

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="fingerprint-dialog-title" slotProps={{ paper: { sx: { width: scaled(640, dialogScale), maxWidth: '95vw' } } }}>
      <DialogTitle id="fingerprint-dialog-title">
        {t('fingerprintDialogTitle')}
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t('fingerprintDialogDescription')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('fingerprintPerceptualHint')}
        </Typography>

        {error ? (
          <Alert severity="error" sx={{ mb: 2 }} role="alert">
            {error}
          </Alert>
        ) : null}

        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, maxHeight: targets.length > 1 ? 180 : undefined, overflow: 'auto' }}>
          {targets.map((target) => (
            <Box key={target.virtualPath} sx={{ py: 0.5 }}>
              <Typography variant="caption" component="div" sx={MONO}>
                {target.virtualPath}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                  {t('fingerprintStoredLabel')}:
                </Typography>
                <HashPresenceChips entry={target.entry} storedAlgorithms={target.stored} localPath={target.localPath} />
              </Box>
            </Box>
          ))}
        </Paper>

        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 650, display: 'block' }}>
          {t('fingerprintContentHashes')}
        </Typography>
        {algorithmGroup(HASH_ALGORITHMS.filter((algorithm) => !PERCEPTUAL_ALGORITHMS.includes(algorithm)))}
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 650, display: 'block', mt: 1 }}>
          {t('fingerprintPerceptualHashes')}
        </Typography>
        {algorithmGroup(PERCEPTUAL_ALGORITHMS)}

        <FormControlLabel
          sx={{ mt: 1, alignItems: 'flex-start' }}
          control={<Checkbox checked={forceOverwrite} onChange={(event) => setForceOverwrite(event.target.checked)} disabled={busy} />}
          label={<Typography variant="body2">{t('fingerprintForceOverwrite')}</Typography>}
        />

        {targets.length > 0 && selected.length > 0 ? (
          <Typography variant="caption" color={eligible.length > 0 ? 'text.secondary' : 'text.disabled'} sx={{ display: 'block', mt: 1 }}>
            {forceOverwrite
              ? t('fingerprintTargetsOverwrite', { count: eligible.length })
              : eligible.length > 0
                ? t('fingerprintTargetsIncremental', { count: eligible.length })
              : t('fingerprintTargetsAllStored')}
          </Typography>
        ) : null}

      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t('cancel')}
        </Button>
        <Button
          variant="contained"
          disabled={busy || targets.length === 0 || selected.length === 0 || eligible.length === 0}
          onClick={() =>
            onCalculate(
              eligible.map((target) => target.virtualPath),
              selected,
              forceOverwrite,
            )
          }
        >
          {busy ? t('fingerprintCalculating') : t('fingerprintCalculate')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
