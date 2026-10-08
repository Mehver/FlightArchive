// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Reusable boarding-pass presentation frame.
 *
 * One frame presents one independent paper slot (front / back) inside a fixed aspect-ratio "ticket" card with layered backing
 * sheets, so a torn or incomplete physical pass still looks composed:
 *
 * - `prepared` (resource + saved layout): the browser-rendered,
  *   upright rectangular bounded crop is
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
import type { PaperBoardingPassLayout } from '../api/types';
import { useBrowserImage } from '../resources/useBrowserImage';
import { useNearViewport } from '../resources/useNearViewport';
import { templateById } from '../scanstudio/templates';
import { useTranslation, type TranslationKey } from '../i18n';
import { placementBox, slotState, type BoardingPassSlotKey } from './passPresentation';

/** Aspect ratio shared by the bundled paper templates (247×100). */
export const DEFAULT_FRAME_ASPECT = 247 / 100;

/** Honest unavailable mark shared by every image the frame requests: a
 *  failed load is never replaced by a misleading fallback image. */
function ImageUnavailable({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const reason = error instanceof Error ? error.message : String(error);
  return (
    <Tooltip title={`${t('bpImageUnavailable')}: ${reason}`}>
      <Box
        role="img"
        aria-label={t('bpImageUnavailable')}
        sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'text.disabled' }}
      >
        <BrokenImageOutlinedIcon fontSize="small" />
      </Box>
    </Tooltip>
  );
}

/** Full-bleed cover image using a bounded browser thumbnail, with a graceful
 *  broken-image fallback instead of an original-route download. */
function CoverImage({ resourcePath, alt, contain = false, enabled, maxDimension }: { resourcePath: string; alt: string; contain?: boolean; enabled: boolean; maxDimension: number }) {
  const image = useBrowserImage(resourcePath, { enabled, maxDimension });
  const [elementFailed, setElementFailed] = useState(false);
  useEffect(() => setElementFailed(false), [resourcePath, image.src]);
  if (image.status === 'failed' || elementFailed) return <ImageUnavailable error={image.status === 'failed' ? image.error : 'image-element-load-failed'} />;
  if (image.status === 'loading') return null;
  return (
    <Box
      component="img"
      src={image.src}
      alt={alt}
      loading="lazy"
      onError={() => setElementFailed(true)}
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

/** A prepared crop uses saved placement and fails closed if relay rendering is unavailable. */
function PreparedPreview({ resourcePath, layout, box, templateUrl, dark, alt, enabled, maxDimension }: {
  resourcePath: string;
  layout: PaperBoardingPassLayout;
  box: NonNullable<ReturnType<typeof placementBox>>;
  templateUrl: string | null;
  dark: boolean;
  alt: string;
  enabled: boolean;
  maxDimension: number;
}) {
  const crop = layout.crop;
  const image = useBrowserImage(resourcePath, { crop, maxDimension, enabled });
  const [elementFailed, setElementFailed] = useState(false);
  useEffect(() => setElementFailed(false), [resourcePath, image.src]);
  if (image.status === 'failed' || elementFailed) return <ImageUnavailable error={image.status === 'failed' ? image.error : 'image-element-load-failed'} />;
  if (image.status === 'loading') return null;
  return (
    <>
      {templateUrl ? <Box component="img" src={templateUrl} alt="" aria-hidden sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.55, filter: dark ? 'invert(1)' : 'none' }} /> : null}
      <Box sx={{ position: 'absolute', left: `${box.leftPct}%`, top: `${box.topPct}%`, width: `${box.widthPct}%`, height: `${box.heightPct}%`, transform: `rotate(${box.rotationDegrees}deg)`, overflow: 'hidden', boxShadow: 1, bgcolor: 'background.paper' }}>
        <Box component="img" src={image.src} alt={alt} loading="lazy" onError={() => setElementFailed(true)} sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', display: 'block' }} />
      </Box>
    </>
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
  resourcePath,
  layout,
  aspectRatio = DEFAULT_FRAME_ASPECT,
  compact = false,
  layered = true,
  maxDimension = 512,
}: {
  slot: BoardingPassSlotKey;
  resourcePath: string | null;
  layout: PaperBoardingPassLayout | undefined;
  /** Width / height of the presentation frame. */
  aspectRatio?: number;
  /** Compact mode: icon-only state hints, single backing sheet (for cards). */
  compact?: boolean;
  /** Whether to render the offset backing sheet(s) behind the face card. */
  layered?: boolean;
  /** Maximum rendered crop dimension; callers may lower this for compact previews. */
  maxDimension?: number;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const visibility = useNearViewport<HTMLElement>();
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
      ref={visibility.ref}
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
          <PreparedPreview resourcePath={resourcePath} layout={layout!} box={box} templateUrl={template?.url ?? null} dark={theme.palette.mode === 'dark'} alt={t(slotLabelKey)} enabled={visibility.enabled} maxDimension={maxDimension} />
        ) : showScan && resourcePath ? (
          <>
            <CoverImage resourcePath={resourcePath} alt={t(slotLabelKey)} enabled={visibility.enabled} maxDimension={maxDimension} />
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
