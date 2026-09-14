// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Display contract of the flight detail sheet:
 *
 * - Unknown catalog codes: valid but uncatalogued airline/airport/aircraft
 *   codes keep their stored code and add a concise bilingual "unlisted
 *   reference" note wherever a catalogued name is expected — never blank,
 *   never the bare code alone. Catalogued entries keep their metadata names.
 * - Files: every unique bound resource appears exactly once near the bottom
 *   — boarding-pass slots first, then attachments — with an image thumbnail
 *   or generic file icon and a direct /res/ download link; a resource bound
 *   to several roles lists all of them on its single row.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Catalogs, FlightRecord } from '../api/types';
import { LanguageProvider } from '../i18n';
import { FlightDetailDialog } from './FlightDetailDialog';

afterEach(cleanup);

const FLIGHT: FlightRecord = {
  id: 'f-1',
  flightNumber: '1234',
  airlineCode: 'ZZ',
  departureAirport: 'AAA',
  arrivalAirport: 'BBB',
  departureTerminal: null,
  arrivalTerminal: null,
  departureDate: '2026-08-01',
  departureTime: '08:30',
  arrivalTime: null,
  aircraftTypeIcao: 'X999',
  registration: null,
  seat: null,

  notes: '',
  createdAt: '2026-08-01T00:00:00',
  updatedAt: '2026-08-01T00:00:00',
  paperBoardingPassFrontResourcePath: null,
  paperBoardingPassBackResourcePath: null,
  electronicBoardingPassResourcePath: null,
  attachmentResourcePaths: [],
  boardingPassColor: null,
};

/** Only the departure airport is catalogued; airline, arrival airport and
 *  aircraft type are valid codes without reference metadata. */
const CATALOGS: Catalogs = {
  airlines: [],
  airports: [
    {
      code: 'AAA',
      icao: '',
      nameZh: '首都机场',
      nameEn: 'Capital',
      cityZh: '北京市',
      cityEn: 'Beijing',
      countryZh: '',
      countryEn: '',
      terminals: [],
    },
  ],
  aircraftTypes: [],
};

function renderDetail(catalogs: Catalogs | null = CATALOGS) {
  render(
    <LanguageProvider>
      <FlightDetailDialog
        flight={FLIGHT}
        catalogs={catalogs}
        airlineNames={new Map()}
        open
        onClose={() => undefined}
      />
    </LanguageProvider>,
  );
}

describe('FlightDetailDialog unknown catalog codes', () => {
  it('keeps a dedicated empty horizontal-logo region in the header', () => {
    renderDetail();
    const region = screen.getByTestId('airline-horizontal-logo-region');
    expect(region.querySelector('img')).toBeNull();
  });

  it('renders a catalogued horizontal logo inside that header region', () => {
    renderDetail({
      ...CATALOGS,
      airlines: [{
        code: 'ZZ', icao: '', nameZh: '', nameEn: 'Zulu Air', alliance: null,
        symbolLogoResourcePath: null,
        horizontalLogoResourcePath: 'logos/zulu.svg',
        horizontalDarkLogoResourcePath: null,
        brandColors: { primary: null, contrast: null },
      }],
    });
    const image = screen.getByTestId('airline-horizontal-logo-region').querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/res/logos/zulu.svg');
  });

  it('uses the shared neutral route decoration', () => {
    renderDetail();
    expect(screen.getAllByTestId('route-connector')).toHaveLength(1);
  });

  it('presents a status-free flight without a retired status badge', () => {
    renderDetail();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.queryByText('已完成')).toBeNull();
  });

  it('shows the stored codes verbatim alongside the bilingual unlisted note', () => {
    renderDetail();
    // Codes themselves are never replaced…
    expect(screen.getByText('AAA')).toBeTruthy();
    expect(screen.getByText('BBB')).toBeTruthy();
    // …and every name slot keeps the code plus the bilingual note. The date
    // now has its own header position instead of sharing the airline line.
    expect(screen.getByText('ZZ · 未收录 · Unlisted')).toBeTruthy();
    expect(screen.getByText('2026-08-01')).toBeTruthy();
    expect(screen.getByText('BBB · 未收录 · Unlisted')).toBeTruthy();
    expect(screen.getByText('X999 · 未收录 · Unlisted')).toBeTruthy();
  });

  it('keeps the catalogued metadata name for listed entries', () => {
    renderDetail();
    expect(screen.getByText('首都机场 · Capital')).toBeTruthy();
    expect(screen.queryByText('AAA · 未收录 · Unlisted')).toBeNull();
  });

  it('renders each route endpoint auxiliary name once without a duplicate city caption', () => {
    renderDetail();
    expect(screen.getAllByText('首都机场 · Capital')).toHaveLength(1);
    expect(screen.queryByText('北京市 · Beijing')).toBeNull();
  });

  it('never falls back to a blank name slot for uncatalogued codes', () => {
    renderDetail(null);
    expect(screen.getByText('ZZ · 未收录 · Unlisted')).toBeTruthy();
    expect(screen.getByText('AAA · 未收录 · Unlisted')).toBeTruthy();
  });
});

describe('FlightDetailDialog read-only contract', () => {
  it('exposes no edit or delete actions and keeps the header close control', () => {
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('button', { name: /close details/i })).toBeTruthy();
  });
});

describe('FlightDetailDialog files', () => {
  /** The paper back and one attachment deliberately share one resource. */
  const FLIGHT_WITH_FILES: FlightRecord = {
    ...FLIGHT,
    paperBoardingPassFrontResourcePath: 'objects/front.png',
    paperBoardingPassBackResourcePath: 'objects/shared.pdf',
    electronicBoardingPassResourcePath: null,
    attachmentResourcePaths: ['objects/shared.pdf', 'objects/notes.txt'],
  };

  function renderWithFiles(flight: FlightRecord = FLIGHT_WITH_FILES) {
    render(
      <LanguageProvider>
        <FlightDetailDialog
          flight={flight}
          catalogs={CATALOGS}
          airlineNames={new Map()}
          open
          onClose={() => undefined}
        />
      </LanguageProvider>,
    );
  }

  it('lists unique resources with boarding-pass slots first, each directly downloadable', () => {
    renderWithFiles();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    // Slots first, then attachments; the shared resource appears once.
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('front.png');
    expect(items[1].textContent).toContain('shared.pdf');
    expect(items[2].textContent).toContain('notes.txt');

    for (const name of ['front.png', 'shared.pdf', 'notes.txt']) {
      const link = screen.getByRole('link', { name: `Download ${name}` });
      expect(link.getAttribute('href')).toBe(`/res/objects/${name}`);
      expect(link.getAttribute('download')).toBe(name);
    }
  });

  it('labels each row with its roles, aggregating a resource shared by several roles', () => {
    renderWithFiles();
    const frontRow = screen.getByText('front.png').closest('li')!;
    expect(within(frontRow).getByText(/paper front/i)).toBeTruthy();
    expect(within(frontRow).queryByText('Attachment')).toBeNull();

    const sharedRow = screen.getByText('shared.pdf').closest('li')!;
    expect(within(sharedRow).getByText(/paper back/i)).toBeTruthy();
    expect(within(sharedRow).getByText('Attachment')).toBeTruthy();

    const notesRow = screen.getByText('notes.txt').closest('li')!;
    expect(within(notesRow).getByText('Attachment')).toBeTruthy();
  });

  it('previews images with the thumbnail route and non-images with the generic file icon', () => {
    renderWithFiles();
    const list = screen.getByRole('list');
    const images = Array.from(list.querySelectorAll('img'));
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe('/images/objects/front.png');
    expect(within(list).getAllByTestId('InsertDriveFileOutlinedIcon')).toHaveLength(2);
  });

   it('uses a saved-layout status rather than an image preview for a prepared electronic pass', () => {
    renderWithFiles({
      ...FLIGHT,
      electronicBoardingPassResourcePath: 'objects/mobile-pass.png',
      electronicBoardingPass: {
        schemaVersion: 1,
        extraction: {
          crop: { centerX: 10, centerY: 10, width: 20, height: 20, mirrorAcrossImageCenterX: false },
        },
      },
       boardingPassColor: '#0A141E',
    });

    const row = screen.getByText('mobile-pass.png').closest('li')!;
    expect(within(row).queryByRole('img')).toBeNull();
    expect(within(row).getByTestId('InsertDriveFileOutlinedIcon')).toBeTruthy();
    expect(within(row).getByText('Saved Layout')).toBeTruthy();
    expect(within(row).queryByRole('img', { name: 'Electronic Boarding Pass' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Boarding Pass Color' }).querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it('omits the file list when nothing is bound', () => {
    renderWithFiles(FLIGHT);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText(/Files/)).toBeNull();
  });
});
