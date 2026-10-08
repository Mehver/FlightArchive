// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { KeyboardEvent } from 'react';
import {
  Alert, Box, Card, CardActionArea, Checkbox, Chip, Pagination, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import { EmptyState } from '../components/States';
import { useTranslation } from '../i18n';
import { basename, fileKind, isImageResource, isPendingInbox, parentFolder } from './resourcePaths';
import { ResourceImage } from './ResourceImage';
import type { ResourceBrowserItem, ResourceBrowserModel, ResourceBrowserView } from './useResourceBrowser';

export interface ResourceBrowserProps {
  browser: ResourceBrowserModel;
  /** Accessible name for the list representation. */
  label: string;
  multiple?: boolean;
}

function TypeIcon({ path }: { path: string }) {
  if (isImageResource(path)) return <ImageOutlinedIcon fontSize="small" color="action" />;
  if (/\.pdf$/i.test(path)) return <PictureAsPdfOutlinedIcon fontSize="small" color="action" />;
  if (/\.(csv|json|log|md|txt)$/i.test(path)) return <ArticleOutlinedIcon fontSize="small" color="action" />;
  return <InsertDriveFileOutlinedIcon fontSize="small" color="action" />;
}

function ClassificationChip({ item }: { item: ResourceBrowserItem }) {
  const { t } = useTranslation();
  if (!item.resource.present) return <Chip size="small" color="error" variant="outlined" label={t('mappingStatusMissing')} />;
  if (isPendingInbox(item.entry.virtual_path)) return <Chip size="small" color="warning" variant="outlined" label={t('resourcePending')} />;
  return <Chip size="small" variant="outlined" label={t('resourceMapped')} />;
}

export function ResourceBrowser({ browser, label, multiple = false }: ResourceBrowserProps) {
  const { t } = useTranslation();
  const keyDown = (event: KeyboardEvent<HTMLElement>, path: string, unavailable: boolean) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      browser.toggle(path, unavailable);
    }
  };

  return <>
    <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
      <TextField size="small" label={t('resourceSearch')} value={browser.query} onChange={(event) => browser.setQuery(event.target.value)} sx={{ flex: '1 1 220px' }} />
      <Box sx={{ flexGrow: 1 }} />
      <ToggleButtonGroup size="small" exclusive value={browser.view} onChange={(_event, next: ResourceBrowserView | null) => next && browser.setView(next)} aria-label={t('resourceViewMode')}>
        <ToggleButton value="thumbnails" aria-label={t('resourceViewThumbnails')}><Tooltip title={t('resourceViewThumbnails')}><GridViewOutlinedIcon fontSize="small" /></Tooltip></ToggleButton>
        <ToggleButton value="list" aria-label={t('resourceViewList')}><Tooltip title={t('resourceViewList')}><ViewListOutlinedIcon fontSize="small" /></Tooltip></ToggleButton>
      </ToggleButtonGroup>
    </Box>
    {browser.error ? <Alert severity="error">{t(browser.error)}</Alert>
      : browser.loading ? <Typography>{t('resourceLoading')}</Typography>
      : browser.visible.length === 0 ? <EmptyState title={t('noEntries')} />
      : <>
        {browser.view === 'thumbnails' ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5 }}>
            {browser.paged.map((item) => {
              const path = item.entry.virtual_path;
              const active = browser.picked.includes(path);
              const unavailable = !item.resource.present;
              return <Card key={path} variant="outlined" sx={{ outline: active ? 2 : 0, outlineColor: 'primary.main', position: 'relative' }}>
                <CardActionArea aria-pressed={active} disabled={unavailable} onClick={() => browser.toggle(path, unavailable)} sx={{ p: 1 }}>
                  <Box sx={{ height: 108, display: 'grid', placeItems: 'center', color: 'text.secondary' }}>
                    {isImageResource(path) && !unavailable ? <ResourceImage resourcePath={path} size={100} alt={basename(path)} /> : <InsertDriveFileOutlinedIcon sx={{ fontSize: 44 }} />}
                  </Box>
                  <Typography variant="caption" noWrap sx={{ display: 'block' }}>{path}</Typography>
                  <Box sx={{ mt: 0.5 }}><ClassificationChip item={item} /></Box>
                  {active ? <CheckCircleIcon color="primary" sx={{ position: 'absolute', right: 6, top: 6 }} /> : null}
                </CardActionArea>
              </Card>;
            })}
          </Box>
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={label}>
            <TableHead><TableRow>
              {multiple ? <TableCell padding="checkbox" /> : null}
              <TableCell>{t('name')}</TableCell><TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>{t('resourceLocation')}</TableCell>
              <TableCell>{t('resourceKind')}</TableCell><TableCell>{t('status')}</TableCell>
            </TableRow></TableHead>
            <TableBody>{browser.paged.map((item) => {
              const path = item.entry.virtual_path;
              const active = browser.picked.includes(path);
              const unavailable = !item.resource.present;
              return <TableRow key={path} hover selected={active} role={multiple ? 'checkbox' : 'radio'} aria-checked={active} aria-disabled={unavailable || undefined} tabIndex={unavailable ? -1 : 0} onClick={() => browser.toggle(path, unavailable)} onKeyDown={(event) => keyDown(event, path, unavailable)} sx={{ cursor: unavailable ? 'not-allowed' : 'pointer', opacity: unavailable ? 0.7 : 1, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
                {multiple ? <TableCell padding="checkbox"><Checkbox checked={active} size="small" disabled={unavailable} disableRipple slotProps={{ input: { readOnly: true, tabIndex: -1, 'aria-hidden': true } }} /></TableCell> : null}
                <TableCell sx={{ maxWidth: 260 }}><Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}><TypeIcon path={path} /><Typography variant="body2" noWrap sx={{ fontWeight: active ? 650 : 400 }}>{basename(path)}</Typography></Box></TableCell>
                <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' }, maxWidth: 220 }}><Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{parentFolder(path) || t('notAvailable')}</Typography></TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}><Typography variant="caption" color="text.secondary">{fileKind(path) || t('notAvailable')}</Typography></TableCell>
                <TableCell><ClassificationChip item={item} /></TableCell>
              </TableRow>;
            })}</TableBody>
          </Table></TableContainer>
        )}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, mt: 2 }}>
          <Typography variant="caption" color="text.secondary">{t('pageIndicator', { from: browser.pageFrom, to: browser.pageTo, total: browser.visible.length })}</Typography>
          {browser.pageCount > 1 ? <Pagination size="small" count={browser.pageCount} page={browser.page} onChange={(_event, value) => browser.setPage(value)} /> : null}
        </Box>
      </>}
  </>;
}
