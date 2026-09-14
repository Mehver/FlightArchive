// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Controlled fingerprint dialog, inspired by the remappable-file-gateway
 * demo's hash workflow but narrowed to FlightArchive's business rule: only
 * object resources bound to persisted flights (boarding passes and attachments)
 * or airline logos can be fingerprinted, and successful values are persisted
 * onto their RFG mapping entries by the backend — never by the browser.
 *
 * The dialog is fully controlled: the parent owns execution, busy state,
 * errors (including 409 ETag conflicts) and terminal results. The dialog
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
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import type { ResourceFingerprintResult } from '../api/types';
import { HASH_ALGORITHMS, PERCEPTUAL_ALGORITHMS, type HashAlgorithm, type MappingEntry } from '../rfg/api';
import { useTranslation, type TranslationKey } from '../i18n';
import { supportsPerceptualFingerprint, targetsMissingAlgorithms, type FingerprintTarget } from './fingerprints';
import { scaled, useDialogScale } from '../utils/dialogScale';

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
};

const CHIP_COMPACT = { height: 20, fontSize: '0.65rem' } as const;

/** Compact six-algorithm presence indicator for one mapping entry. */
export function HashPresenceChips({ entry, localPath = entry.local_path }: { entry: MappingEntry; localPath?: string }) {
  const { t } = useTranslation();
  return (
    <Box component="span" sx={{ display: 'inline-flex', flexWrap: 'wrap', gap: 0.5 }}>
      {HASH_ALGORITHMS.map((algorithm) => {
        const value = entry[algorithm];
        const stored = typeof value === 'string' && value.length > 0;
        const applicable = !PERCEPTUAL_ALGORITHMS.includes(algorithm) || supportsPerceptualFingerprint(localPath);
        return (
          <Tooltip key={algorithm} title={!applicable ? t('fingerprintNotApplicable') : stored ? value : t('fingerprintNotStored')}>
            <Chip
              size="small"
              variant={stored ? 'filled' : 'outlined'}
              color={stored ? 'success' : 'default'}
              label={ALGORITHM_LABEL[algorithm]}
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

export interface FingerprintDialogError {
  message: string;
  conflict: boolean;
}

function ResultRow({ result }: { result: ResourceFingerprintResult }) {
  const { t } = useTranslation();
  const succeeded = result.status === 'succeeded' && result.value;
  const codeKey = RESULT_CODE_KEY[result.code];
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
      {succeeded ? (
        <CheckCircleIcon fontSize="small" color="success" aria-hidden />
      ) : (
        <HighlightOffIcon fontSize="small" color="error" aria-hidden />
      )}
      <Typography variant="caption" sx={{ ...MONO, minWidth: 56, flexShrink: 0 }}>
        {ALGORITHM_LABEL[result.algorithm]}
      </Typography>
      {succeeded ? (
        <Tooltip title={result.value}>
          <Typography variant="caption" component="div" noWrap sx={{ ...MONO, flex: 1, minWidth: 0 }}>
            {result.value}
          </Typography>
        </Tooltip>
      ) : (
        <Typography variant="caption" color="error" sx={{ flex: 1, minWidth: 0 }}>
          {codeKey ? t(codeKey) : `${t('fingerprintCodeHashFailed')} (${result.code})`}
        </Typography>
      )}
      {result.profile ? (
        <Chip size="small" variant="outlined" label={result.profile} sx={{ ...CHIP_COMPACT, flexShrink: 0 }} />
      ) : null}
      <Chip
        size="small"
        variant="outlined"
        color={result.persisted ? 'success' : 'default'}
        label={result.persisted ? t('fingerprintPersisted') : t('fingerprintNotStored')}
        sx={{ ...CHIP_COMPACT, flexShrink: 0 }}
      />
    </Box>
  );
}

export function FingerprintDialog({
  open,
  batch,
  targets,
  busy,
  error,
  results,
  onCalculate,
  onClose,
}: {
  open: boolean;
  /** Batch mode: targets are all currently eligible business-bound resources. */
  batch: boolean;
  /** Eligible targets resolved from the latest rows; empty after a reload
   *  made the reviewed selection stale (e.g. a concurrent rematch). */
  targets: FingerprintTarget[];
  busy: boolean;
  error: FingerprintDialogError | null;
  /** Terminal results of the last run; null before/while running. */
  results: ResourceFingerprintResult[] | null;
  onCalculate: (virtualPaths: string[], algorithms: HashAlgorithm[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogScale = useDialogScale();
  const [chosen, setChosen] = useState<ReadonlySet<HashAlgorithm>>(() => new Set(HASH_ALGORITHMS));

  useEffect(() => {
    if (open) setChosen(new Set(HASH_ALGORITHMS.filter((algorithm) => targets.some((target) => target.supported.includes(algorithm)))));
  }, [open, targets]);

  const selected = useMemo(() => HASH_ALGORITHMS.filter((algorithm) => chosen.has(algorithm)), [chosen]);
  // Single-resource runs recompute explicitly chosen algorithms; batch runs
  // skip targets that already store every selected algorithm.
  const eligible = useMemo(
    () => (batch ? targetsMissingAlgorithms(targets, selected) : targets),
    [batch, targets, selected],
  );

  const toggle = (algorithm: HashAlgorithm) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(algorithm)) next.delete(algorithm);
      else next.add(algorithm);
      return next;
    });

  const groupedResults = useMemo(() => {
    const groups: { virtualPath: string; items: ResourceFingerprintResult[] }[] = [];
    for (const result of results ?? []) {
      let group = groups.find((candidate) => candidate.virtualPath === result.virtualPath);
      if (!group) {
        group = { virtualPath: result.virtualPath, items: [] };
        groups.push(group);
      }
      group.items.push(result);
    }
    return groups;
  }, [results]);

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
        {batch ? t('fingerprintDialogTitleBatch', { count: targets.length }) : t('fingerprintDialogTitle')}
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t('fingerprintDialogDescription')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('fingerprintPerceptualHint')}
        </Typography>

        {error ? (
          <Alert severity={error.conflict ? 'warning' : 'error'} sx={{ mb: 2 }} role="alert">
            {error.message}
          </Alert>
        ) : null}

        {targets.length === 0 ? (
          <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
            {t('fingerprintTargetsStale')}
          </Alert>
        ) : (
          <Paper variant="outlined" sx={{ p: 1.5, mb: 2, maxHeight: batch ? 180 : undefined, overflow: 'auto' }}>
            {targets.map((target) => (
              <Box key={target.virtualPath} sx={{ py: 0.5 }}>
                <Typography variant="caption" component="div" sx={MONO}>
                  {target.virtualPath}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {t('fingerprintStoredLabel')}:
                  </Typography>
                  <HashPresenceChips entry={target.entry} localPath={target.localPath} />
                </Box>
              </Box>
            ))}
          </Paper>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 650, display: 'block' }}>
          {t('fingerprintContentHashes')}
        </Typography>
        {algorithmGroup(HASH_ALGORITHMS.filter((algorithm) => !PERCEPTUAL_ALGORITHMS.includes(algorithm)))}
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 650, display: 'block', mt: 1 }}>
          {t('fingerprintPerceptualHashes')}
        </Typography>
        {algorithmGroup(PERCEPTUAL_ALGORITHMS)}

        {batch && targets.length > 0 && selected.length > 0 ? (
          <Typography variant="caption" color={eligible.length > 0 ? 'text.secondary' : 'text.disabled'} sx={{ display: 'block', mt: 1 }}>
            {eligible.length > 0
              ? t('fingerprintTargetsBatch', { count: eligible.length })
              : t('fingerprintTargetsAllStored')}
          </Typography>
        ) : null}

        {results ? (
          <Paper variant="outlined" sx={{ p: 1.5, mt: 2, maxHeight: 260, overflow: 'auto' }} aria-live="polite">
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 650, display: 'block', mb: 0.5 }}>
              {t('fingerprintResults')}
            </Typography>
            {groupedResults.map((group) => (
              <Box key={group.virtualPath} sx={{ mb: 1 }}>
                <Typography variant="caption" component="div" sx={MONO}>
                  {group.virtualPath}
                </Typography>
                {group.items.map((result) => (
                  <ResultRow key={result.algorithm} result={result} />
                ))}
              </Box>
            ))}
          </Paper>
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
            )
          }
        >
          {busy ? t('fingerprintCalculating') : t('fingerprintCalculate')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
