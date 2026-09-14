// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider, useTranslation } from './index';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = '';
});

function LanguageControl() {
  const { language, t, toggleLanguage } = useTranslation();
  return <button type="button" onClick={toggleLanguage}>{`${language}: ${t('save')}`}</button>;
}

describe('LanguageProvider accessibility state', () => {
  it('publishes the active language to the document and persists a user toggle', () => {
    localStorage.setItem('flightarchive.ui.language', 'en');
    render(<LanguageProvider><LanguageControl /></LanguageProvider>);

    expect(document.documentElement.lang).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'en: Save' }));

    expect(document.documentElement.lang).toBe('zh-CN');
    expect(localStorage.getItem('flightarchive.ui.language')).toBe('zh-CN');
    expect(screen.getByRole('button', { name: /保存/ })).toBeTruthy();
  });
});
