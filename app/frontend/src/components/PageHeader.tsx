// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/** Consistent page header with optional actions. */

import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        // Keep actions at the same top offset whether the title has a
        // subtitle or not. Centering made a no-subtitle header place its
        // actions visibly closer to the application bar.
        alignItems: 'flex-start',
        flexDirection: { xs: 'column', sm: 'row' },
        justifyContent: 'space-between',
        gap: 1.5,
        pt: 1,
        mb: 2.5,
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h6" component="h1">
          {title}
        </Typography>
        {subtitle ? (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        ) : null}
      </Box>
      {actions ? (
        <Box
          sx={{
            display: 'flex',
            flex: { xs: '1 1 100%', sm: '0 1 auto' },
            width: { xs: '100%', sm: 'auto' },
            maxWidth: '100%',
            gap: 1,
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: { xs: 'flex-start', sm: 'flex-end' },
          }}
        >
          {actions}
        </Box>
      ) : null}
    </Box>
  );
}
