// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Shared empty / error / loading state blocks. */

import { Box, Button, CircularProgress, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 6, justifyContent: 'center' }} role="status">
      <CircularProgress size={26} />
       <Typography color="text.secondary">{label ?? t('loading')}</Typography>
    </Box>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <Box sx={{ textAlign: 'center', py: 6, px: 2 }}>
      <Typography variant="subtitle1" color="text.secondary" gutterBottom>
        {title}
      </Typography>
      {hint ? (
        <Typography variant="body2" color="text.disabled" sx={{ mb: 2 }}>
          {hint}
        </Typography>
      ) : null}
      {action}
    </Box>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ textAlign: 'center', py: 6, px: 2 }} role="alert">
      <Typography variant="subtitle1" color="error" gutterBottom>
        {message}
      </Typography>
      {onRetry ? (
        <Button variant="outlined" onClick={onRetry} sx={{ mt: 1 }}>
          {t('retry')}
        </Button>
      ) : null}
    </Box>
  );
}
