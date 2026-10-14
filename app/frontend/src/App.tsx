// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useMemo, useRef, useState, type ChangeEvent, type MouseEvent, type ReactNode } from 'react';
import {
  AppBar,
  Box,
  Badge,
  Chip,
  CssBaseline,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import FlightTakeoffIcon from '@mui/icons-material/FlightTakeoff';
import LibraryBooksOutlinedIcon from '@mui/icons-material/LibraryBooksOutlined';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined';
import SyncOutlinedIcon from '@mui/icons-material/SyncOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { AppStateProvider, useAppState } from './state/AppState';
import { buildTheme } from './theme';
import { FlightsPage } from './flights/FlightsPage';
import { ReferenceLibraryPage } from './reference/ReferenceLibraryPage';
import { ResourceMappingsPage } from './resources/ResourceMappingsPage';
import { FeedbackDrawer } from './tasks/FeedbackDrawer';
import { useTranslation } from './i18n';
import { useBusinessData } from './domain/BusinessDataProvider';

const DRAWER_WIDTH = 232;

type PageKey = 'flights' | 'flightReference' | 'resourceMappings';

export function BusinessDataActions() {
  const { t } = useTranslation();
  const business = useBusinessData();
  const { connectivity, recheckConnection, notify, reportFailure } = useAppState();
  const inputRef = useRef<HTMLInputElement>(null);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const failed = Object.entries(business.documents).filter(([, state]) => state.error);
  const dirty = Object.entries(business.documents).filter(([, state]) => state.dirty);
  const progress = business.saveAllProgress;
  const savingDocument = Object.entries(business.documents).find(([, state]) => state.saving)?.[0]
    ?? (progress.status === 'running' && progress.completed >= progress.total ? 'manifest.json' : null);
  const saving = Object.values(business.documents).some((state) => state.saving || state.pending > 0)
    || progress.status === 'running';
  const menuOpen = Boolean(anchorEl);
  const connectionLabel = t(`connection${connectivity[0].toUpperCase()}${connectivity.slice(1)}` as 'connectionChecking' | 'connectionOnline' | 'connectionOffline');
  const triggerLabel = `${t('connectionStatus')}: ${connectionLabel}`;
  const hasFailure = business.phase === 'error' || failed.length > 0 || progress.status === 'failed';
  const hasWarning = !hasFailure && dirty.length > 0;

  const saveAll = () => {
    void business.saveAll().then((result) => {
      if (result.failed.length) {
        const error = new Error('one or more business data documents could not be saved');
        reportFailure(error, {
          fallback: t('businessDataSaveProgressFailed', { completed: 5 - result.failed.length, total: 5 }),
          context: { form: 'business-data' },
          activity: { source: 'frontend-business-data', kind: 'persistence', severity: 'error', state: 'failed', code: 'archive-save-all-failed', details: { failed: result.failed } },
        });
      } else notify(t('businessDataSaveProgressSucceeded', { completed: 5, total: 5 }), 'success', { form: 'business-data' });
    }).catch((error: unknown) => {
      reportFailure(error, { fallback: t('businessDataSaveUnexpectedFailure'), context: { form: 'business-data' } });
    });
  };

  const retryFailed = () => {
    if (progress.failed.includes('manifest.json')) {
      saveAll();
      return;
    }
    for (const [id] of failed) {
      void business.retryDocument(id as keyof typeof business.documents).catch(() => undefined);
    }
  };

  const closeMenu = () => setAnchorEl(null);
  const dismissMenu = () => {
    const trigger = anchorEl;
    setAnchorEl(null);
    queueMicrotask(() => trigger?.focus());
  };
  const openMenu = (event: MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const result = await business.importBusinessData(JSON.parse(await file.text()));
      if (result.failed.length) {
        const error = new Error('one or more imported business data documents could not be saved');
        reportFailure(error, {
          fallback: t('businessDataImportFailed'), context: { form: 'business-data-import' },
          activity: { source: 'frontend-business-data', kind: 'persistence', severity: 'error', state: 'failed', code: 'archive-import-failed', details: { failed: result.failed } },
        });
      } else notify(t('businessDataSaveProgressSucceeded', { completed: 5, total: 5 }), 'success', { form: 'business-data-import' });
    } catch (error) {
      reportFailure(error, { fallback: t('businessDataImportFailed'), context: { form: 'business-data-import' } });
    }
  };

  return (
    <>
      <Tooltip title={triggerLabel}>
        <IconButton
          aria-label={triggerLabel}
          aria-haspopup="menu"
          aria-controls={menuOpen ? 'business-data-menu' : undefined}
          aria-expanded={menuOpen ? 'true' : undefined}
          color={connectivity === 'offline' ? 'error' : connectivity === 'checking' ? 'warning' : undefined}
          onClick={openMenu}
          sx={connectivity === 'online' ? { color: 'productAccent.main' } : undefined}
        >
          <Badge color={hasFailure ? 'error' : 'warning'} variant="dot" invisible={!hasFailure && !hasWarning}>
            {connectivity === 'online' ? <CloudDoneOutlinedIcon /> : connectivity === 'offline' ? <CloudOffOutlinedIcon /> : <SyncOutlinedIcon />}
          </Badge>
        </IconButton>
      </Tooltip>
      <Menu
        id="business-data-menu"
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={dismissMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ px: 2, py: 1, minWidth: 240 }}>
          <Typography variant="subtitle2">{triggerLabel}</Typography>
          {business.phase === 'error' ? <Chip sx={{ mt: 0.75 }} size="small" color="error" label={t('businessDataLoadFailed')} /> : null}
          {dirty.length > 0 ? (
            <Chip
              sx={{ mt: 0.75, mr: 0.5 }}
              size="small"
              color={failed.length > 0 ? 'error' : 'warning'}
              label={failed.length > 0 ? t('saveFailed', { count: failed.length }) : saving ? t('saving') : t('unsavedChanges', { count: dirty.length })}
            />
          ) : null}
          {progress.status !== 'idle' ? (
            <Tooltip title={progress.failed.length > 0 ? t('businessDataFailedDocuments', { documents: progress.failed.join(', ') }) : ''}>
              <Chip
                sx={{ mt: 0.75 }}
                size="small"
                color={progress.status === 'failed' ? 'error' : progress.status === 'succeeded' ? 'success' : 'info'}
                label={progress.status === 'running'
                  ? t('businessDataSavingProgress', { document: savingDocument ?? t('saving'), completed: progress.completed, total: progress.total })
                  : progress.status === 'failed'
                    ? t('businessDataSaveProgressFailed', { completed: progress.completed, total: progress.total })
                    : t('businessDataSaveProgressSucceeded', { completed: progress.completed, total: progress.total })}
              />
            </Tooltip>
          ) : null}
        </Box>
        <Divider />
        <MenuItem onClick={saveAll} disabled={!business.data || saving}>{t('saveAll')}</MenuItem>
        <MenuItem onClick={() => { closeMenu(); inputRef.current?.click(); }} disabled={!business.data}>{t('importData')}</MenuItem>
        <MenuItem onClick={() => { closeMenu(); business.downloadBusinessData(); }} disabled={!business.data}>{t('exportData')}</MenuItem>
        {failed.length > 0 || progress.status === 'failed' ? <MenuItem onClick={retryFailed} disabled={saving}>{t('retryFailed')}</MenuItem> : null}
        <Divider />
        <MenuItem onClick={() => { closeMenu(); void recheckConnection(); }}>{t('recheckConnection')}</MenuItem>
      </Menu>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onClick={(event) => { event.currentTarget.value = ''; }}
        onChange={(event) => void importFile(event)}
      />
    </>
  );
}

function Shell() {
  const {
    observedActivityRevision, hasUnreadActivity, markActivityRead,
  } = useAppState();
  const { language, toggleLanguage, t } = useTranslation();
  const [page, setPage] = useState<PageKey>('flights');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(() => {
    try {
      return localStorage.getItem('flightarchive.ui.drawerOpen') === 'true';
    } catch {
      return false;
    }
  });
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [dark, setDark] = useState<boolean | null>(null);
  const mode: 'light' | 'dark' = dark === null ? (prefersDark ? 'dark' : 'light') : dark ? 'dark' : 'light';
  const theme = useMemo(() => buildTheme(mode), [mode]);
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const drawerWidth = isDesktop ? (drawerOpen ? DRAWER_WIDTH : 64) : DRAWER_WIDTH;

  const primaryItems: { key: PageKey; label: string; icon: ReactNode }[] = [
    { key: 'flights', label: t('flightDisplay'), icon: <FlightTakeoffIcon /> },
    { key: 'flightReference', label: t('flightReference'), icon: <LibraryBooksOutlinedIcon /> },
  ];
  const advancedItems: { key: PageKey; label: string; icon: ReactNode }[] = [
    { key: 'resourceMappings', label: t('resourceMappings'), icon: <AccountTreeIcon /> },
  ];

  const navButton = (item: { key: PageKey; label: string; icon: ReactNode }) => (
    <Tooltip title={item.label} key={item.key}>
      <ListItemButton
        selected={page === item.key}
        onClick={() => {
          setPage(item.key);
          setMobileOpen(false);
        }}
        sx={{ mx: 1, borderRadius: 2, justifyContent: drawerOpen ? 'flex-start' : 'center', px: drawerOpen ? 2 : 1 }}
      >
        <ListItemIcon sx={{ minWidth: drawerOpen ? 40 : 0, justifyContent: 'center' }}>{item.icon}</ListItemIcon>
        {drawerOpen ? <ListItemText primary={item.label} /> : null}
      </ListItemButton>
    </Tooltip>
  );

  const nav = (
    <Box role="navigation" aria-label={t('mainNavigation')} sx={{ pt: 1 }}>
      <List>{[...primaryItems, ...advancedItems].map(navButton)}</List>
    </Box>
  );

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', minHeight: '100vh' }}>
        <AppBar
          position="fixed"
          color="default"
          sx={{
            width: { md: `calc(100% - ${drawerWidth}px)` },
            ml: { md: `${drawerWidth}px` },
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
          }}
          elevation={0}
        >
          <Toolbar sx={{ gap: 1 }}>
            {!isDesktop ? (
              <IconButton aria-label={t('openNavigation')} onClick={() => setMobileOpen(true)} edge="start">
                <MenuIcon />
              </IconButton>
            ) : null}
            <Box
              component="img"
              src="/256.png"
              alt="FlightArchive"
              sx={{ width: 32, height: 32, borderRadius: 1, objectFit: 'cover' }}
            />
            <Typography variant="h6" component="div" sx={{ flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              FlightArchive
            </Typography>
            <BusinessDataActions />
            <Tooltip title={t('feedbackCenter')}>
              <IconButton aria-label={t('feedbackCenter')} onClick={() => setTasksOpen(true)}>
                <Badge color="error" variant="dot" invisible={!hasUnreadActivity}>
                  <NotificationsOutlinedIcon />
                </Badge>
              </IconButton>
            </Tooltip>
            <Tooltip title={language === 'en' ? t('switchToChinese') : t('switchToEnglish')}>
              <IconButton aria-label={language === 'en' ? t('switchToChinese') : t('switchToEnglish')} onClick={toggleLanguage}>
                <Typography variant="caption" component="span" sx={{ fontWeight: 700 }}>
                  {language === 'en' ? t('languageToggleChinese') : t('languageToggleEnglish')}
                </Typography>
              </IconButton>
            </Tooltip>
            <Tooltip title={mode === 'dark' ? t('switchToLight') : t('switchToDark')}>
              <IconButton aria-label={t('toggleColorScheme')} onClick={() => setDark(mode !== 'dark')}>
                {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
              </IconButton>
            </Tooltip>
          </Toolbar>
        </AppBar>

        {isDesktop ? (
          <Drawer
            variant="permanent"
            sx={{
              width: drawerWidth,
              '& .MuiDrawer-paper': { width: drawerWidth, boxSizing: 'border-box', overflowX: 'hidden', transition: (theme) => theme.transitions.create('width') },
            }}
            open
          >
            <Toolbar />
            <Box sx={{ display: 'flex', justifyContent: drawerOpen ? 'flex-end' : 'center', px: 1 }}>
              <IconButton onClick={() => setDrawerOpen((prev) => {
                const next = !prev;
                try { localStorage.setItem('flightarchive.ui.drawerOpen', String(next)); } catch {}
                return next;
              })} size="small">
                {drawerOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
              </IconButton>
            </Box>
            {nav}
          </Drawer>
        ) : (
          <Drawer
            variant="temporary"
            open={mobileOpen}
            onClose={() => setMobileOpen(false)}
            ModalProps={{ keepMounted: true }}
            sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' } }}
          >
            <Toolbar />
            {nav}
          </Drawer>
        )}

        <FeedbackDrawer
          open={tasksOpen}
          onClose={() => setTasksOpen(false)}
          observedActivityRevision={observedActivityRevision}
          onActivityRead={markActivityRead}
        />

        <Box
          component="main"
          sx={{
            flexGrow: 1,
              width: { md: `calc(100% - ${drawerWidth}px)` },
            px: { xs: 2, sm: 3 },
            pb: 4,
          }}
        >
          <Toolbar />
          {page === 'flights' ? <FlightsPage /> : null}
          {page === 'flightReference' ? <ReferenceLibraryPage /> : null}
          {page === 'resourceMappings' ? <ResourceMappingsPage /> : null}
        </Box>
      </Box>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}
