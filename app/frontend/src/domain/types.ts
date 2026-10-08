// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

export type HexColor = `#${string}`;
export interface BrandColors { primary: HexColor | null; contrast: HexColor | null }
export interface Airline { code: string; icao: string; nameZh: string; nameEn: string; alliance: string | null; horizontalLogoResourcePath: string | null; horizontalDarkLogoResourcePath: string | null; symbolLogoResourcePath: string | null; brandColors: BrandColors }
export interface Airport { code: string; icao: string; nameZh: string; nameEn: string; cityZh: string; cityEn: string; countryZh: string; countryEn: string; terminals: string[] }
export interface AircraftType { icao: string; iata: string; manufacturer: string | null; displayName: string }
export interface PaperBoardingPassLayout {
  schemaVersion: 1;
  algorithm: 'adaptive' | 'canny' | 'sobel' | 'laplacian';
  crop: { centerX: number; centerY: number; width: number; height: number; rotationDegrees: number; /** Legacy, readable but ignored. */ corners?: { x: number; y: number }[] };
  templateId: string;
  placement: { scale: number; rotationDegrees: number; offsetX: number; offsetY: number };
}
export interface ElectronicBoardingPassPresentation {
  schemaVersion: 1;
  extraction?: { crop: { centerX: number; centerY: number; width: number; height: number; mirrorAcrossImageCenterX: boolean }; presetName?: string } | null;
}
export interface FlightRecord {
  id: string; flightNumber: string; airlineCode: string; departureAirport: string; arrivalAirport: string;
  departureTerminal: string | null; arrivalTerminal: string | null; departureDate: string; departureTime: string | null; arrivalTime: string | null;
  aircraftTypeIcao: string | null; registration: string | null; seat: string | null; notes: string; createdAt: string; updatedAt: string;
  paperBoardingPassFrontResourcePath: string | null; paperBoardingPassBackResourcePath: string | null; electronicBoardingPassResourcePath: string | null;
  attachmentResourcePaths: string[];
  paperBoardingPassLayouts?: Partial<Record<'paperBoardingPassFront' | 'paperBoardingPassBack', PaperBoardingPassLayout>>;
  electronicBoardingPass?: ElectronicBoardingPassPresentation | null;
  boardingPassColor: HexColor | null;
}
export interface Catalogs { airlines: Airline[]; airports: Airport[]; aircraftTypes: AircraftType[] }
export interface BusinessData extends Catalogs { schemaVersion: 1; flights: FlightRecord[]; settings: Record<string, string> }
export type CatalogKind = 'airlines' | 'airports' | 'aircraft-types';
