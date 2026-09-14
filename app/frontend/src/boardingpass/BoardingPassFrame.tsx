// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Reusable boarding-pass presentation frame.
 *
 * One frame presents one independent paper slot (front / back) inside a fixed aspect-ratio "ticket" card with layered backing
 * sheets, so a torn or incomplete physical pass still looks composed:
 *
* - `prepared` (resource + saved layout): the server-rendered,
  *   upright rectangular WebP crop from the boarding-pass preview route is
  *   shown exactly inside the persisted placement geometry — template backing
  *   (when the authored template is known) plus the placed/rotated crop
  *   rectangle. The template SVG is rendered **behind** the preview image
  *   (see the `prepared` branch below), so torn or missing parts of the
  *   boarding pass show the template's hatch pattern through. The preview
  *   image is the true saved crop, never a generic thumbnail re-cropped by
  *   CSS. Nothing is mutated or re-persisted.
 * - `unprepared` (resource, no layout): the bound scan fills the frame behind
 *   an explicit "unprepared scan" badge — never pretending to be finished.
 * - `absent`: a deliberate dashed placeholder sheet in the same location.
 *
 * The frame is template-agnostic: the aspect ratio is a prop and any template
 * artwork comes from the persisted layout's templateId.
 */

import { useEffect, useState } from 'react';
import { Box, Tooltip, Typography } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { useTheme } from '@mui/material/styles';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import ConfirmationNumberOutlinedIcon from '@mui/icons-material/ConfirmationNumberOutlined';
import DocumentScannerOutlinedIcon from '@mui/icons-material/DocumentScannerOutlined';
import { resourceDisplayUrl } from '../rfg/api';
import { boardingPassPreviewUrl } from '../api/client';
import type { PaperBoardingPassLayout } from '../api/types';
import { templateById } from '../scanstudio/templates';
import { useTranslation, type TranslationKey } from '../i18n';
import { placementBox, slotState, type BoardingPassSlotKey } from './passPresentation';

/** Aspect ratio shared by the bundled paper templates (247×100). */
export const DEFAULT_FRAME_ASPECT = 247 / 100;

/** Honest unavailable mark shared by every image the frame requests: a
 *  failed load is never replaced by a misleading fallback image. */
function ImageUnavailable() {
  const { t } = useTranslation();
  return (
    <Box
      role="img"
      aria-label={t('bpImageUnavailable')}
      sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'text.disabled' }}
    >
      <BrokenImageOutlinedIcon fontSize="small" />
    </Box>
  );
}

/** Full-bleed cover image using the cached thumbnail, with a graceful
 *  broken-image fallback instead of an original-route download. */
function CoverImage({ resourcePath, alt, contain = false }: { resourcePath: string; alt: string; contain?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [resourcePath]);
  if (failed) return <ImageUnavailable />;
  return (
    <Box
      component="img"
      src={resourceDisplayUrl(resourcePath)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      sx={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: contain ? 'contain' : 'cover',
        display: 'block',
      }}
    />
  );
}

/** The true prepared crop of one slot: the preview route returns the
  *  upright rectangular WebP of the saved source crop, and the placement
 *  box it sits in is derived from that same crop geometry — so the image
 *  fills the box exactly, with no CSS cover-cropping approximation. A failed
 *  preview shows the honest unavailable mark, never the raw scan. */
function PreviewImage({ flightId, slot, alt }: { flightId: string; slot: BoardingPassSlotKey; alt: string }) {
  const src = boardingPassPreviewUrl(flightId, slot);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <ImageUnavailable />;
  return (
    <Box
      component="img"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      sx={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'fill',
        display: 'block',
      }}
    />
  );
}

const paperFace = {
  background: (theme: Theme) =>
    theme.palette.mode === 'dark'
      ? 'linear-gradient(135deg, rgba(66,72,88,0.55) 0%, rgba(44,48,60,0.85) 100%)'
      : 'linear-gradient(135deg, #fdfcf7 0%, #f2efe4 100%)',
};

export function BoardingPassFrame({
  slot,
  flightId,
  resourcePath,
  layout,
  aspectRatio = DEFAULT_FRAME_ASPECT,
  compact = false,
  layered = true,
}: {
  slot: BoardingPassSlotKey;
  /** Owning flight — the prepared paper-preview route is addressed by flight id. */
  flightId: string;
  resourcePath: string | null;
  layout: PaperBoardingPassLayout | undefined;
  /** Width / height of the presentation frame. */
  aspectRatio?: number;
  /** Compact mode: icon-only state hints, single backing sheet (for cards). */
  compact?: boolean;
  /** Whether to render the offset backing sheet(s) behind the face card. */
  layered?: boolean;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const state = slotState(resourcePath, layout);
  const templateSide = slot === 'paperBoardingPassBack' ? 'back' : 'front';
  const template = layout ? templateById(layout.templateId, templateSide) : null;
  const box = layout && resourcePath ? placementBox(layout, template ?? { width: 247, height: 100 }) : null;
  // A "prepared" slot whose persisted geometry is unusable is shown honestly
  // as an unprepared scan rather than with invented placement.
  const prepared = state === 'prepared' && resourcePath !== null && box !== null;
  const showScan = resourcePath !== null && (state === 'unprepared' || (state === 'prepared' && !prepared));

  const slotLabelKey: TranslationKey = slot === 'paperBoardingPassFront' ? 'boardingPassFront' : 'boardingPassBack';
  const stateLabel = prepared ? t('hasBoardingPassLayout') : showScan ? t('bpUnprepared') : t('bpNotBound');

  const PlaceholderIcon = ConfirmationNumberOutlinedIcon;

  return (
    <Box
      role="img"
      aria-label={`${t(slotLabelKey)} · ${stateLabel}`}
      sx={{ position: 'relative', width: '100%', aspectRatio: String(aspectRatio) }}
    >
      {layered ? (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'action.hover',
            transform: compact ? 'rotate(-1.4deg) translateY(3%)' : 'rotate(-1.8deg) translateY(4%)',
          }}
        />
      ) : null}
      {layered && !compact ? (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            transform: 'rotate(1.1deg) translateY(1.5%)',
          }}
        />
      ) : null}
      <Box
        sx={[
          {
            position: 'absolute',
            inset: 0,
            borderRadius: 1,
            overflow: 'hidden',
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
          },
          paperFace,
        ]}
      >
        {prepared && resourcePath ? (
          <>
            {template ? (
              <Box
                component="img"
                src={template.url}
                alt=""
                aria-hidden
                sx={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: 0.55,
                  filter: theme.palette.mode === 'dark' ? 'invert(1)' : 'none',
                }}
              />
            ) : null}
            <Box
              sx={{
                position: 'absolute',
                left: `${box.leftPct}%`,
                top: `${box.topPct}%`,
                width: `${box.widthPct}%`,
                height: `${box.heightPct}%`,
                transform: `rotate(${box.rotationDegrees}deg)`,
                overflow: 'hidden',
                boxShadow: 1,
                bgcolor: 'background.paper',
              }}
            >
              <PreviewImage flightId={flightId} slot={slot} alt={t(slotLabelKey)} />
            </Box>
          </>
        ) : showScan && resourcePath ? (
          <>
            <CoverImage resourcePath={resourcePath} alt={t(slotLabelKey)} />
            <Tooltip title={t('bpUnpreparedHint')}>
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'rgba(0, 0, 0, 0.35)',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 1,
                    py: 0.5,
                    borderRadius: 1,
                    bgcolor: 'rgba(0, 0, 0, 0.58)',
                    color: '#fff',
                  }}
                >
                  <DocumentScannerOutlinedIcon sx={{ fontSize: compact ? 16 : 18 }} />
                  {compact ? null : (
                    <Typography variant="caption" component="span" sx={{ lineHeight: 1.4 }}>
                      {t('bpUnprepared')}
                    </Typography>
                  )}
                </Box>
              </Box>
            </Tooltip>
          </>
        ) : (
          <Box
            sx={{
              position: 'absolute',
              inset: 6,
              borderRadius: 1,
              border: '1.5px dashed',
              borderColor: 'divider',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.25,
              color: 'text.disabled',
            }}
          >
            <PlaceholderIcon sx={{ fontSize: compact ? 18 : 22 }} />
            {compact ? null : (
              <Typography variant="caption" component="span" sx={{ lineHeight: 1.3 }}>
                {t('bpNotBound')}
              </Typography>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
