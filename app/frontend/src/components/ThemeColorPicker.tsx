// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useState } from 'react';
import { Box, InputAdornment, TextField } from '@mui/material';
import { hexToCss, isValidHexColor, type HexColor } from '../theme/colors';

export interface ThemeColorPickerProps {
  label: string;
  value: HexColor | null;
  onChange: (color: HexColor | null) => void;
}

export function ThemeColorPicker({ label, value, onChange }: ThemeColorPickerProps) {
  const [inputValue, setInputValue] = useState(value ? value.slice(1) : '');

  useEffect(() => {
    setInputValue(value ? value.slice(1) : '');
  }, [value]);

  const updateInput = (raw: string) => {
    const upper = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 6);
    setInputValue(upper);
    if (upper.length === 6) {
      const candidate = `#${upper}` as HexColor;
      if (isValidHexColor(candidate)) onChange(candidate);
    } else if (upper.length === 0) {
      onChange(null);
    }
  };

  const isComplete = inputValue.length === 6;
  const isValid = !isComplete || isValidHexColor(`#${inputValue}` as HexColor);
  const previewColor = isComplete && isValid ? hexToCss(`#${inputValue}` as HexColor) : 'transparent';

  return (
    <Box sx={{ display: 'flex', flex: '1 1 calc(50% - 8px)', alignItems: 'center', gap: 1, minWidth: 0 }}>
      <Box
        aria-label={`${label} preview`}
        sx={{ width: 36, height: 36, flex: '0 0 auto', borderRadius: 1, border: 1, borderColor: 'divider', bgcolor: previewColor }}
      />
      <TextField
        label={label}
        value={inputValue}
        onChange={(event) => updateInput(event.target.value)}
        error={!isValid}
        placeholder="RRGGBB"
        sx={{ flex: '1 1 auto', minWidth: 0 }}
        slotProps={{
          input: {
            startAdornment: <InputAdornment position="start">#</InputAdornment>,
          },
          htmlInput: { maxLength: 6, inputMode: 'text', autoCapitalize: 'characters' },
        }}
      />
    </Box>
  );
}
