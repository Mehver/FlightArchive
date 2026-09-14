// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { FlightRecord } from '../api/types';
import { ElectronicBoardingPassStudio } from './ElectronicBoardingPassStudio';
import { PaperBoardingPassStudio } from './PaperBoardingPassStudio';

export type BoardingPassSlot = 'paperBoardingPassFront' | 'paperBoardingPassBack' | 'electronicBoardingPass';

export interface ScanStudioDialogProps {
  open: boolean;
  flight: FlightRecord;
  slot: BoardingPassSlot;
  onSaved: (flight: FlightRecord) => void;
  onClose: () => void;
}

/** Routes each boarding-pass media type to its dedicated editing workflow. */
export function ScanStudioDialog(props: ScanStudioDialogProps) {
  if (props.slot === 'electronicBoardingPass') return <ElectronicBoardingPassStudio {...props} />;
  return <PaperBoardingPassStudio {...props} />;
}
