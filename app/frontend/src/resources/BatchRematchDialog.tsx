// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, FormGroup, List, ListItem, ListItemButton, ListItemText, TextField, Typography } from '@mui/material';
import type { MappingEntry } from '../rfg/api';
import { useTranslation } from '../i18n';

export type BatchMatchAlgorithm = 'filename' | 'sizeBytes' | 'crc32' | 'md5' | 'sha256' | 'ahash' | 'dhash' | 'phash';
const algorithms: BatchMatchAlgorithm[] = ['filename', 'sizeBytes', 'sha256', 'md5', 'crc32', 'phash'];

/** A deliberately text-only picker for selecting several pending local files. */
export function BatchRematchDialog({ open, candidates, busy, onApply, onClose }: {
  open: boolean; candidates: MappingEntry[]; busy: boolean;
  onApply: (paths: string[], algorithms: BatchMatchAlgorithm[]) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [chosen, setChosen] = useState<BatchMatchAlgorithm[]>(['filename', 'sizeBytes']);
  const [query, setQuery] = useState('');
  useEffect(() => { if (open) { setSelected([]); setChosen(['filename', 'sizeBytes']); setQuery(''); } }, [open]);
  const toggle = (path: string) => setSelected((old) => old.includes(path) ? old.filter((item) => item !== path) : [...old, path]);
  const toggleAlgorithm = (algorithm: BatchMatchAlgorithm) => setChosen((old) => old.includes(algorithm) ? old.filter((item) => item !== algorithm) : [...old, algorithm]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? candidates.filter((entry) => `${entry.local_path} ${entry.virtual_path}`.toLowerCase().includes(needle)) : candidates;
  }, [candidates, query]);
  const allVisibleSelected = visible.length > 0 && visible.every((entry) => selected.includes(entry.virtual_path));
  const toggleVisible = () => setSelected((old) => allVisibleSelected
    ? old.filter((path) => !visible.some((entry) => entry.virtual_path === path))
    : [...new Set([...old, ...visible.map((entry) => entry.virtual_path)])]);
  return <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
    <DialogTitle>{t('batchRematchTitle')}</DialogTitle>
    <DialogContent dividers>
      <Typography variant="body2" color="text.secondary">{t('batchRematchDescription')}</Typography>
       {!candidates.length ? <Alert severity="info" sx={{ mt: 2 }}>{t('batchRematchNoCandidates')}</Alert> : <>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 2 }}>
          <TextField size="small" fullWidth label={t('batchRematchSearch')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <Button onClick={toggleVisible} disabled={busy || !visible.length} aria-label={allVisibleSelected ? t('batchRematchClearVisible') : t('batchRematchSelectVisible')}>
            {allVisibleSelected ? t('batchRematchClearVisible') : t('batchRematchSelectVisible')}
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{t('batchRematchSelectedCount', { count: selected.length })}</Typography>
        {!visible.length ? <Alert severity="info" sx={{ mt: 1 }}>{t('noEntries')}</Alert> : <List dense sx={{ maxHeight: 300, overflow: 'auto', mt: 1 }} aria-label={t('batchRematchCandidates')}>
        {visible.map((entry) => <ListItem key={entry.virtual_path} disablePadding><ListItemButton onClick={() => toggle(entry.virtual_path)} disabled={busy} dense role="checkbox" aria-checked={selected.includes(entry.virtual_path)}>
          <Checkbox checked={selected.includes(entry.virtual_path)} tabIndex={-1} disabled={busy} />
          <ListItemText primary={<Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{entry.local_path}</Typography>} secondary={entry.virtual_path} />
        </ListItemButton></ListItem>)}
       </List>}</>}
      <Typography variant="subtitle2" sx={{ mt: 2 }}>{t('batchRematchAlgorithms')}</Typography>
      <FormGroup row>{algorithms.map((algorithm) => <FormControlLabel key={algorithm} control={<Checkbox disabled={busy} checked={chosen.includes(algorithm)} onChange={() => toggleAlgorithm(algorithm)} />} label={t(`batchRematchAlgorithm${algorithm[0].toUpperCase()}${algorithm.slice(1)}` as never)} />)}</FormGroup>
      <Typography variant="caption" color="text.secondary">{t('batchRematchUniqueHint')}</Typography>
    </DialogContent>
    <DialogActions><Button onClick={onClose}>{t('cancel')}</Button><Button variant="contained" disabled={busy || !selected.length || !chosen.length} onClick={() => onApply(selected, chosen)}>{busy ? t('batchRematchWorking') : t('batchRematchApply')}</Button></DialogActions>
  </Dialog>;
}
