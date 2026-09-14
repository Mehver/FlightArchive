// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en } from './en';
import { zh } from './zh';

export type Language = 'en' | 'zh-CN';
export type TranslationKey = keyof typeof en;
export type TranslationParams = Record<string, string | number | undefined>;
const STORAGE_KEY = 'flightarchive.ui.language';
const dictionaries = { en, 'zh-CN': zh } as const;

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch { /* storage may be unavailable */ }
  return typeof navigator !== 'undefined' && /^zh(?:-|$)/i.test(navigator.language) ? 'zh-CN' : 'en';
}

function interpolate(template: string, params?: TranslationParams) {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? `{${name}}`));
}

interface I18nValue {
  language: Language;
  toggleLanguage: () => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
}
const I18nContext = createContext<I18nValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    try { localStorage.setItem(STORAGE_KEY, language); } catch { /* best effort only */ }
  }, [language]);
  const value = useMemo<I18nValue>(() => ({
    language,
    toggleLanguage: () => setLanguageState((current) => current === 'en' ? 'zh-CN' : 'en'),
    t: (key, params) => interpolate(dictionaries[language][key], params),
  }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useTranslation must be used inside LanguageProvider');
  return value;
}
