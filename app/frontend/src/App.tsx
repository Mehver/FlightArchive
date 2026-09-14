// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useMemo, useState, type ReactNode } from 'react';
import {
  AppBar,
  Box,
  CssBaseline,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
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
import { TasksPage } from './tasks/TasksPage';
import { useTranslation } from './i18n';

const DRAWER_WIDTH = 232;

type PageKey = 'flights' | 'flightReference' | 'resourceMappings';

function Shell() {
  const { connectivity, recheckConnection } = useAppState();
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
            <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
              FlightArchive
            </Typography>
            <Tooltip title={`${t('connectionStatus')}: ${t(`connection${connectivity[0].toUpperCase()}${connectivity.slice(1)}` as 'connectionChecking' | 'connectionOnline' | 'connectionOffline')}. ${t('recheckConnection')}`}>
              <IconButton
                aria-label={`${t('connectionStatus')}: ${t(`connection${connectivity[0].toUpperCase()}${connectivity.slice(1)}` as 'connectionChecking' | 'connectionOnline' | 'connectionOffline')}. ${t('recheckConnection')}`}
                color={connectivity === 'offline' ? 'error' : connectivity === 'checking' ? 'warning' : undefined}
                onClick={() => { void recheckConnection(); }}
                sx={connectivity === 'online' ? {
                  color: 'productAccent.main',
                } : undefined}
              >
                {connectivity === 'online' ? <CloudDoneOutlinedIcon /> : connectivity === 'offline' ? <CloudOffOutlinedIcon /> : <SyncOutlinedIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title={t('tasks')}>
              <IconButton aria-label={t('tasks')} onClick={() => setTasksOpen(true)}>
                <NotificationsOutlinedIcon />
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

        <Drawer
          anchor="right"
          open={tasksOpen}
          onClose={() => setTasksOpen(false)}
          slotProps={{ paper: { sx: { width: { xs: '100%', sm: 520 }, maxWidth: '100%' } } }}
        >
          <Box sx={{ p: { xs: 2, sm: 2.5 }, minHeight: '100%' }}>
            <TasksPage onClose={() => setTasksOpen(false)} />
          </Box>
        </Drawer>

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
