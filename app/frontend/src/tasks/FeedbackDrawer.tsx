// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { Box, Drawer } from '@mui/material';
import { TasksPage } from './TasksPage';

/** Reusable shell for the combined session activity and backend-task panel. */
export function FeedbackDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 520 }, maxWidth: '100%' } } }}
    >
      {open ? (
        <Box sx={{ p: { xs: 2, sm: 2.5 }, minHeight: '100%' }}>
          <TasksPage onClose={onClose} />
        </Box>
      ) : null}
    </Drawer>
  );
}
