// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Composition of the three independent boarding-pass slots of a flight.
 *
 * Usage contexts (naming convention):
 *   - "detail card" = FlightDetailDialog (full-screen detail sheet)
 *   - "preview card" = FlightGridView card (browse mode, shows front BP as cover)
 *   - "list thumbnail" = small boarding pass image in FlightListView rows
 *
 * Modes:
 *   - Full mode  (compact={false}) → used in the detail card (FlightDetailDialog):
 *     paper front/back are previewable frames; electronic presentation is a
 *     labeled saved-layout or scan state because no electronic preview API exists.
 *   - Compact mode (compact={true})  → used in the preview card (FlightGridView):
 *     one composed layered stack — the paper back peeks behind the paper front
 *     (its true saved crop from the preview route when prepared, its raw scan
 *     thumbnail when explicitly unprepared, a plain backing sheet otherwise),
 *     and a bound electronic pass appears as a small offset corner card — so
 *     a partial or torn set of scans still reads as one deliberate ticket object.
 */

import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import ConfirmationNumberOutlinedIcon from '@mui/icons-material/ConfirmationNumberOutlined';
import QrCode2OutlinedIcon from '@mui/icons-material/QrCode2Outlined';
import type { FlightRecord } from '../api/types';
import { boardingPassPreviewUrl } from '../api/client';
import { resourceDisplayUrl } from '../rfg/api';
import { useTranslation, type TranslationKey } from '../i18n';
import { BoardingPassFrame, DEFAULT_FRAME_ASPECT } from './BoardingPassFrame';
import { BOARDING_PASS_SLOTS, slotLayout, slotResourcePath, slotState, type BoardingPassSlotKey } from './passPresentation';

type DisplaySlotKey = BoardingPassSlotKey | 'electronicBoardingPass';

const SLOT_LABEL_KEY: Record<DisplaySlotKey, TranslationKey> = {
  paperBoardingPassFront: 'boardingPassFront',
  paperBoardingPassBack: 'boardingPassBack',
  electronicBoardingPass: 'electronicBoardingPass',
};

function SlotIcon({ slot }: { slot: DisplaySlotKey }) {
  return slot === 'electronicBoardingPass' ? (
    <QrCode2OutlinedIcon sx={{ fontSize: 14 }} />
  ) : (
    <ConfirmationNumberOutlinedIcon sx={{ fontSize: 14 }} />
  );
}

/** Small backing sheet used by compact mode: the backing paper side's true
 *  saved crop (preview route, fitted whole with `contain`) when it is
 *  prepared, its raw scan thumbnail (`cover`) when it is explicitly
 *  unprepared, or a deliberately plain card when nothing is bound. A failed
 *  image degrades to the plain sheet — a prepared side never falls back to
 *  its raw scan — and the failure state resets whenever the source changes. */
function BackingSheet({
  flightId,
  slot,
  resourcePath,
  prepared,
  alt,
}: {
  flightId: string;
  slot: BoardingPassSlotKey;
  resourcePath: string | null;
  prepared: boolean;
  alt: string;
}) {
  const src = resourcePath === null ? null : prepared ? boardingPassPreviewUrl(flightId, slot) : resourceDisplayUrl(resourcePath);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'action.hover',
        background: (theme) =>
          theme.palette.mode === 'dark'
            ? 'linear-gradient(135deg, rgba(66,72,88,0.4), rgba(40,44,54,0.75))'
            : 'linear-gradient(135deg, #f6f3e9, #e9e5d5)',
        transform: 'rotate(-2deg) translateY(4%)',
        overflow: 'hidden',
      }}
    >
      {src && !failed ? (
        <Box
          component="img"
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          sx={{ width: '100%', height: '100%', objectFit: prepared ? 'contain' : 'cover', display: 'block', opacity: 0.85 }}
        />
      ) : null}
    </Box>
  );
}

/** Compact electronic state. Saved electronic layouts have no server preview,
 * so they deliberately show a status rather than issuing a request that cannot
 * succeed. An unprepared bound scan keeps its generic thumbnail. */
function ElectronicMiniCard({ resourcePath, prepared, alt, savedLayoutLabel }: { resourcePath: string | null; prepared: boolean; alt: string; savedLayoutLabel: string }) {
  return (
    <Box
      role="img"
      aria-label={alt}
      sx={{
        position: 'absolute',
        right: '3%',
        bottom: '-4%',
        width: '24%',
        aspectRatio: '0.72',
        borderRadius: 1.5,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        boxShadow: 2,
        transform: 'rotate(3deg)',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
        color: 'text.disabled',
      }}
    >
      {prepared ? (
        <>
          <QrCode2OutlinedIcon sx={{ fontSize: 20 }} />
          <Typography variant="caption" component="span" sx={{ position: 'absolute', bottom: 2, px: 0.25, fontSize: '0.5rem', lineHeight: 1, bgcolor: 'background.paper' }}>
            {savedLayoutLabel}
          </Typography>
        </>
      ) : (
        <>
          <QrCode2OutlinedIcon sx={{ position: 'absolute', fontSize: 20 }} />
          {resourcePath ? (
            <Box
              component="img"
              src={resourceDisplayUrl(resourcePath)}
              alt={alt}
              loading="lazy"
              sx={{ position: 'relative', width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : null}
        </>
      )}
    </Box>
  );
}

export function BoardingPassTrio({ flight, compact = false }: { flight: FlightRecord; /** compact=preview card, full=detail card */ compact?: boolean }) {
  const { t } = useTranslation();

  if (compact) {
    const frontPath = slotResourcePath(flight, 'paperBoardingPassFront');
    const backPath = slotResourcePath(flight, 'paperBoardingPassBack');
    const electronicPath = flight.electronicBoardingPassResourcePath;
    // The face shows the most complete paper side available; whichever side
    // is missing still contributes its backing sheet in the same location.
    const faceSlot: BoardingPassSlotKey = frontPath !== null || backPath === null ? 'paperBoardingPassFront' : 'paperBoardingPassBack';
    const backingSlot: BoardingPassSlotKey = faceSlot === 'paperBoardingPassFront' ? 'paperBoardingPassBack' : 'paperBoardingPassFront';
    const backingPath = slotResourcePath(flight, backingSlot);
    const backingPrepared = slotState(backingPath, slotLayout(flight, backingSlot)) === 'prepared';
    const electronicPrepared = Boolean(flight.electronicBoardingPass?.extraction);
    return (
      <Box sx={{ position: 'relative', width: '100%', aspectRatio: String(DEFAULT_FRAME_ASPECT) }}>
        <BackingSheet flightId={flight.id} slot={backingSlot} resourcePath={backingPath} prepared={backingPrepared} alt={t('boardingPassBack')} />
        <BoardingPassFrame
          slot={faceSlot}
          flightId={flight.id}
          resourcePath={slotResourcePath(flight, faceSlot)}
          layout={slotLayout(flight, faceSlot)}
          compact
          layered={false}
        />
        {electronicPath ? (
          <ElectronicMiniCard resourcePath={electronicPath} prepared={electronicPrepared} alt={`${t('electronicBoardingPass')} · ${electronicPrepared ? t('hasBoardingPassLayout') : t('bpUnprepared')}`} savedLayoutLabel={t('hasBoardingPassLayout')} />
        ) : null}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
      {BOARDING_PASS_SLOTS.map((slot) => (
        <Box key={slot} sx={{ flex: '1 1 190px', minWidth: 170 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.75, fontWeight: 600 }}
          >
            <SlotIcon slot={slot} />
            {t(SLOT_LABEL_KEY[slot])}
          </Typography>
          <BoardingPassFrame slot={slot} flightId={flight.id} resourcePath={slotResourcePath(flight, slot)} layout={slotLayout(flight, slot)} />
        </Box>
      ))}
      <Box sx={{ flex: '1 1 190px', minWidth: 170 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          component="div"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.75, fontWeight: 600 }}
        >
          <SlotIcon slot="electronicBoardingPass" />
          {t(SLOT_LABEL_KEY.electronicBoardingPass)}
        </Typography>
        <ElectronicMiniCard
          resourcePath={flight.electronicBoardingPassResourcePath}
          prepared={Boolean(flight.electronicBoardingPass?.extraction)}
          alt={`${t('electronicBoardingPass')} · ${flight.electronicBoardingPass?.extraction ? t('hasBoardingPassLayout') : flight.electronicBoardingPassResourcePath ? t('bpUnprepared') : t('bpNotBound')}`}
          savedLayoutLabel={t('hasBoardingPassLayout')}
        />
      </Box>
    </Box>
  );
}
