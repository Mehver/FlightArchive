// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LanguageProvider } from './i18n';
import { ResourceMappingProvider } from './rfg/ResourceMappingProvider';
import { FeedbackProvider } from './feedback/FeedbackCenter';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider><FeedbackProvider><ResourceMappingProvider><App /></ResourceMappingProvider></FeedbackProvider></LanguageProvider>
  </StrictMode>,
);
