// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useState } from 'react';
import { Box, Button, Chip, Tooltip, Typography } from '@mui/material';
import { ResourceImage } from './ResourceImage';
import { ResourcePickerDialog } from './ResourcePickerDialog';
import { useTranslation } from '../i18n';

export function ResourceSlotField({
  label,
  resourcePath,
  onChange,
  onOpenStudio,
  studioDisabled,
  studioDisabledTooltip,
  hasLayout,
  variant = 'card',
  imageContain = false,
}: {
  label: string;
  resourcePath: string | null;
  onChange: (path: string | null) => void;
  onOpenStudio?: () => void;
  studioDisabled?: boolean;
  studioDisabledTooltip?: string;
  hasLayout?: boolean;
  /** `card` renders the original bordered box; `list` fills available width. */
  variant?: 'card' | 'list';
  /** Fit the entire resource in its preview instead of cropping it. */
  imageContain?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (variant === 'list') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', minWidth: 0 }}>
        <Typography variant="body1" sx={{ minWidth: 130, flex: '0 0 auto', fontWeight: 500, fontSize: '0.95rem' }}>
          {label}
        </Typography>
        {resourcePath ? (
          <ResourceImage resourcePath={resourcePath} size={44} alt={label} contain={imageContain} />
        ) : (
          <Box sx={{ width: 44, height: 44, border: '1px dashed', borderColor: 'divider', borderRadius: 1, display: 'grid', placeItems: 'center', color: 'text.disabled', flex: '0 0 auto' }}>
            <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>—</Typography>
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', flex: '1 1 auto', minWidth: 0 }}>
          <Button size="small" variant="text" onClick={() => setOpen(true)}>
            {resourcePath ? t('changeResource') : t('selectResource')}
          </Button>
          {resourcePath ? (
            <Button size="small" variant="text" color="error" onClick={() => onChange(null)}>
              {t('clearResource')}
            </Button>
          ) : null}
          {onOpenStudio ? (
            <Tooltip title={studioDisabledTooltip ?? ''} disableHoverListener={!studioDisabled || !studioDisabledTooltip}>
              <span>
                <Button size="small" variant="text" disabled={!resourcePath || studioDisabled} onClick={onOpenStudio}>
                  {t('studioOpen')}
                </Button>
              </span>
            </Tooltip>
          ) : null}
        </Box>
        {hasLayout ? (
          <Chip size="small" variant="outlined" color="success" label={t('hasBoardingPassLayout')} />
        ) : null}
        <ResourcePickerDialog
          open={open}
          title={label}
          selected={resourcePath ? [resourcePath] : []}
          imageOnly
          onConfirm={(paths) => {
            onChange(paths[0] ?? null);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      </Box>
    );
  }

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.5, width: 280, flex: '0 0 auto' }}>
      <Typography variant="caption">{label}</Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mt: 1 }}>
         {resourcePath ? <ResourceImage resourcePath={resourcePath} size={56} alt={label} contain={imageContain} /> : null}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, flex: 1, minWidth: 0 }}>
          <Button size="small" onClick={() => setOpen(true)}>
            {resourcePath ? t('changeResource') : t('selectResource')}
          </Button>
          {resourcePath ? (
            <Button size="small" color="error" onClick={() => onChange(null)}>
              {t('clearResource')}
            </Button>
          ) : null}
          {onOpenStudio ? (
            <Tooltip title={studioDisabledTooltip ?? ''} disableHoverListener={!studioDisabled || !studioDisabledTooltip}>
              <span>
                <Button size="small" disabled={!resourcePath || studioDisabled} onClick={onOpenStudio}>
                  {t('studioOpen')}
                </Button>
              </span>
            </Tooltip>
          ) : null}
        </Box>
      </Box>
      {hasLayout ? (
        <Chip size="small" variant="outlined" color="success" label={t('hasBoardingPassLayout')} sx={{ mt: 0.5 }} />
      ) : null}
      <ResourcePickerDialog
        open={open}
        title={label}
        selected={resourcePath ? [resourcePath] : []}
        imageOnly
        onConfirm={(paths) => {
          onChange(paths[0] ?? null);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}
