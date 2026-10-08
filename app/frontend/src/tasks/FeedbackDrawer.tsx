// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { Box, Drawer } from '@mui/material';
import { TasksPage } from './TasksPage';

/** Reusable shell for the combined session activity and backend history panel. */
export function FeedbackDrawer({ open, onClose, observedActivityRevision, onActivityRead }: {
  open: boolean;
  onClose: () => void;
  observedActivityRevision?: string | null;
  onActivityRead?: (revision: string | null) => void;
}) {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 520 }, maxWidth: '100%' } } }}
    >
      {open ? (
        <Box sx={{ p: { xs: 2, sm: 2.5 }, minHeight: '100%' }}>
          <TasksPage onClose={onClose} observedActivityRevision={observedActivityRevision} onActivityRead={onActivityRead} />
        </Box>
      ) : null}
    </Drawer>
  );
}
