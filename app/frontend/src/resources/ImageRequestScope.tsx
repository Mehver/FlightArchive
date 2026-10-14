// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';

const ImageRequestActive = createContext(true);

export function ImageRequestScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = useContext(ImageRequestActive);
  return <ImageRequestActive.Provider value={parentActive && active}>{children}</ImageRequestActive.Provider>;
}

function subscribeDocumentVisibility(notify: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
}

function documentVisible(): boolean { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; }

export function useImageRequestActive(): boolean {
  const scopeActive = useContext(ImageRequestActive);
  const visible = useSyncExternalStore(subscribeDocumentVisibility, documentVisible, () => true);
  return scopeActive && visible;
}
