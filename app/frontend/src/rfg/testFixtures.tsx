// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import type { ReactNode } from 'react';
import { ResourceMappingProvider } from './ResourceMappingProvider';
import type { LocalCatalog, MappingDocument, RfgClient } from './api';

export function fakeRfgClient(document: MappingDocument, catalog: LocalCatalog): RfgClient {
  let current = structuredClone(document);
  return {
    getCatalog: async () => structuredClone(catalog),
    getMapping: async () => ({ document: structuredClone(current), etag: null }),
    putMapping: async (next) => { current = structuredClone(next); return structuredClone(current); },
    computeHash: async ({ local_path, algorithm }) => ({ local_path, algorithm, profile: null, code: 'computed', detail: null, status: 'succeeded', value: `${algorithm}-value`, error: null }),
    getResource: async () => new Response(),
    headResource: async () => new Response(),
  };
}

export function ResourceTestWrapper({ children, client }: { children: ReactNode; client: RfgClient }) {
  return <ResourceMappingProvider client={client}>{children}</ResourceMappingProvider>;
}
