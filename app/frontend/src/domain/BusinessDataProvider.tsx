// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api/client';
import {
  createFlight as createFlightCommand,
  deleteCatalogEntries as deleteCatalogEntriesCommand,
  deleteFlight as deleteFlightCommand,
  updateFlight as updateFlightCommand,
  updateSettings as updateSettingsCommand,
  upsertCatalogEntry as upsertCatalogEntryCommand,
  type CommandDependencies,
} from './commands';
import {
  aggregateBusinessData,
  BUSINESS_DATA_DOCUMENT_IDS,
  BUSINESS_DATA_MANIFEST,
  parseBusinessDataManifest,
  splitBusinessData,
  type BusinessDataDocumentId,
  type BusinessDataDocuments,
} from './archiveV2';
import { parseBusinessDataV1 } from './schemaV1';
import type { AircraftType, Airline, Airport, BusinessData, CatalogKind, FlightRecord } from './types';

export type ArchiveJsonValue = null | boolean | number | string | ArchiveJsonValue[] | { [key: string]: ArchiveJsonValue };

export interface ArchiveTransport {
  getArchiveDocument(appId: string, documentId: string, signal?: AbortSignal): Promise<ArchiveJsonValue>;
  putArchiveDocument(appId: string, documentId: string, document: ArchiveJsonValue): Promise<void>;
  deleteArchiveDocument(appId: string, documentId: string): Promise<void>;
}

export interface DocumentPersistenceState {
  dirty: boolean;
  saving: boolean;
  pending: number;
  generation: number;
  error: Error | null;
}

export interface DocumentSaveResult {
  documentId: BusinessDataDocumentId;
  generation: number;
  ok: boolean;
  error?: Error;
}

export interface SaveAllResult {
  failed: Array<BusinessDataDocumentId | 'manifest.json'>;
}

export interface SaveAllProgress {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  completed: number;
  total: number;
  failed: Array<BusinessDataDocumentId | 'manifest.json'>;
}

type CatalogEntry = Airline | Airport | AircraftType;

export interface BusinessDataContextValue {
  phase: 'loading' | 'ready' | 'error';
  data: BusinessData | null;
  loadError: Error | null;
  documents: Record<BusinessDataDocumentId, DocumentPersistenceState>;
  saveAllProgress: SaveAllProgress;
  createFlight(input: unknown): FlightRecord;
  updateFlight(id: string, changes: unknown): FlightRecord;
  deleteFlight(id: string): FlightRecord;
  upsertCatalogEntry(kind: CatalogKind, key: string, changes: unknown): CatalogEntry;
  deleteCatalogEntries(kind: CatalogKind, keys: readonly string[], force?: boolean): CatalogEntry[];
  updateSettings(settings: unknown): Record<string, string>;
  retryDocument(documentId: BusinessDataDocumentId): Promise<DocumentSaveResult>;
  saveDocument(documentId: BusinessDataDocumentId): Promise<DocumentSaveResult>;
  saveAll(): Promise<SaveAllResult>;
  importBusinessData(value: unknown): Promise<SaveAllResult>;
  exportBusinessData(): string;
  downloadBusinessData(filename?: string): void;
  reload(options?: { discardChanges?: boolean }): Promise<void>;
  whenIdle(): Promise<void>;
}

export class DirtyBusinessDataError extends Error {
  constructor() {
    super('business data has unsaved changes; explicitly discard them before reloading');
    this.name = 'DirtyBusinessDataError';
  }
}

const APP_ID = 'flightarchive';
const DEFAULT_DEPENDENCIES: CommandDependencies = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};
const DEFAULT_TRANSPORT: ArchiveTransport = {
  getArchiveDocument: (appId, documentId, signal) => api.getArchiveDocument(appId, documentId, signal),
  putArchiveDocument: (appId, documentId, document) => api.putArchiveDocument(appId, documentId, document),
  deleteArchiveDocument: (appId, documentId) => api.deleteArchiveDocument(appId, documentId),
};

function errorFrom(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function reportPersistenceFailure(documentId: string, error: Error): void {
  void api.reportActivity({
    source: 'frontend-business-data',
    kind: 'persistence',
    severity: 'error',
    state: 'failed',
    code: 'archive-document-save-failed',
    details: { documentId, message: error.message },
  }).catch(() => undefined);
}

function cleanDocumentStates(): Record<BusinessDataDocumentId, DocumentPersistenceState> {
  return Object.fromEntries(BUSINESS_DATA_DOCUMENT_IDS.map((id) => [id, {
    dirty: false,
    saving: false,
    pending: 0,
    generation: 0,
    error: null,
  }])) as Record<BusinessDataDocumentId, DocumentPersistenceState>;
}

function catalogEntries(data: BusinessData, kind: CatalogKind): CatalogEntry[] {
  if (kind === 'airlines') return data.airlines;
  if (kind === 'airports') return data.airports;
  return data.aircraftTypes;
}

const BusinessDataContext = createContext<BusinessDataContextValue | null>(null);

export function BusinessDataProvider({
  children,
  transport = DEFAULT_TRANSPORT,
  dependencies = DEFAULT_DEPENDENCIES,
}: {
  children: ReactNode;
  transport?: ArchiveTransport;
  dependencies?: CommandDependencies;
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [data, setData] = useState<BusinessData | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [documents, setDocuments] = useState(cleanDocumentStates);
  const [saveAllProgress, setSaveAllProgress] = useState<SaveAllProgress>({ status: 'idle', completed: 0, total: 5, failed: [] });
  const workingRef = useRef<BusinessData | null>(null);
  const documentsRef = useRef(documents);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const queueActivityRef = useRef(0);

  const replaceDocumentState = useCallback((documentId: BusinessDataDocumentId, update: (current: DocumentPersistenceState) => DocumentPersistenceState) => {
    const next = { ...documentsRef.current, [documentId]: update(documentsRef.current[documentId]) };
    documentsRef.current = next;
    setDocuments(next);
  }, []);

  const enqueueWork = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const result = queueRef.current.then(work, work);
    queueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const enqueueDocument = useCallback((documentId: BusinessDataDocumentId, snapshot: unknown, generation: number): Promise<DocumentSaveResult> => {
    const persistedSnapshot = structuredClone(snapshot) as ArchiveJsonValue;
    queueActivityRef.current += 1;
    replaceDocumentState(documentId, (state) => ({ ...state, pending: state.pending + 1 }));
    return enqueueWork(async () => {
      replaceDocumentState(documentId, (state) => ({ ...state, saving: true }));
      try {
        await transport.putArchiveDocument(APP_ID, documentId, persistedSnapshot);
        replaceDocumentState(documentId, (state) => state.generation === generation
          ? { ...state, dirty: false, error: null }
          : state);
        return { documentId, generation, ok: true };
      } catch (reason) {
        const error = errorFrom(reason);
        replaceDocumentState(documentId, (state) => state.generation === generation
          ? { ...state, dirty: true, error }
          : state);
        reportPersistenceFailure(documentId, error);
        throw error;
      } finally {
        replaceDocumentState(documentId, (state) => ({ ...state, pending: Math.max(0, state.pending - 1), saving: state.pending > 1 }));
      }
    });
  }, [enqueueWork, replaceDocumentState, transport]);

  const requireWorking = useCallback((): BusinessData => {
    if (!workingRef.current) throw new Error('business data is not loaded');
    return workingRef.current;
  }, []);

  const applyCommand = useCallback((next: BusinessData, affected: readonly BusinessDataDocumentId[]) => {
    workingRef.current = next;
    setData(next);
    const snapshots = splitBusinessData(next);
    for (const documentId of affected) {
      const generation = documentsRef.current[documentId].generation + 1;
      replaceDocumentState(documentId, (state) => ({ ...state, dirty: true, error: null, generation }));
      void enqueueDocument(documentId, snapshots[documentId], generation).catch(() => undefined);
    }
  }, [enqueueDocument, replaceDocumentState]);

  const createFlight = useCallback((input: unknown) => {
    const next = createFlightCommand(requireWorking(), input, dependencies);
    applyCommand(next, ['flights.json']);
    return next.flights.at(-1)!;
  }, [applyCommand, dependencies, requireWorking]);

  const updateFlight = useCallback((id: string, changes: unknown) => {
    const next = updateFlightCommand(requireWorking(), id, changes, dependencies);
    applyCommand(next, ['flights.json']);
    return next.flights.find((flight) => flight.id === id)!;
  }, [applyCommand, dependencies, requireWorking]);

  const deleteFlight = useCallback((id: string) => {
    const current = requireWorking();
    const deleted = current.flights.find((flight) => flight.id === id);
    if (!deleted) {
      deleteFlightCommand(current, id);
      throw new Error('unreachable');
    }
    applyCommand(deleteFlightCommand(current, id), ['flights.json']);
    return deleted;
  }, [applyCommand, requireWorking]);

  const upsertCatalogEntry = useCallback((kind: CatalogKind, key: string, changes: unknown) => {
    const next = upsertCatalogEntryCommand(requireWorking(), kind, key, changes);
    applyCommand(next, [kind === 'aircraft-types' ? 'aircraft-types.json' : `${kind}.json`]);
    const normalizedKey = key.trim().toUpperCase();
    return catalogEntries(next, kind).find((entry) => ('code' in entry ? entry.code : entry.icao) === normalizedKey)!;
  }, [applyCommand, requireWorking]);

  const deleteCatalogEntries = useCallback((kind: CatalogKind, keys: readonly string[], force = false) => {
    const current = requireWorking();
    const normalized = new Set(keys.map((key) => key.trim().toUpperCase()));
    const deleted = catalogEntries(current, kind).filter((entry) => normalized.has('code' in entry ? entry.code : entry.icao));
    const next = deleteCatalogEntriesCommand(current, kind, keys, force);
    applyCommand(next, [kind === 'aircraft-types' ? 'aircraft-types.json' : `${kind}.json`]);
    return deleted;
  }, [applyCommand, requireWorking]);

  const updateSettings = useCallback((settings: unknown) => {
    const next = updateSettingsCommand(requireWorking(), settings);
    applyCommand(next, ['settings.json']);
    return next.settings;
  }, [applyCommand, requireWorking]);

  const retryDocument = useCallback((documentId: BusinessDataDocumentId) => {
    const snapshot = splitBusinessData(requireWorking())[documentId];
    const generation = documentsRef.current[documentId].generation;
    replaceDocumentState(documentId, (state) => ({ ...state, dirty: true, error: null }));
    return enqueueDocument(documentId, snapshot, generation);
  }, [enqueueDocument, replaceDocumentState, requireWorking]);

  const saveDocument = useCallback(async (documentId: BusinessDataDocumentId): Promise<DocumentSaveResult> => {
    // Commands enqueue their immutable snapshot synchronously. Keep joining
    // the queue if a newer generation for this document arrived while the
    // original write was in flight, so callers observe the latest relevant
    // generation without dispatching a duplicate write.
    while (documentsRef.current[documentId].pending > 0) await queueRef.current;
    const state = documentsRef.current[documentId];
    if (state.error) throw state.error;
    if (state.dirty) throw new Error(`${documentId} still has unsaved changes`);
    return { documentId, generation: state.generation, ok: true };
  }, []);

  const saveAll = useCallback(async (): Promise<SaveAllResult> => {
    const snapshots = splitBusinessData(requireWorking());
    setSaveAllProgress({ status: 'running', completed: 0, total: 5, failed: [] });
    const writes = BUSINESS_DATA_DOCUMENT_IDS.map((documentId) => {
      const generation = documentsRef.current[documentId].generation;
      return enqueueDocument(documentId, snapshots[documentId], generation).then(
        () => ({ documentId, ok: true as const }),
        () => ({ documentId, ok: false as const }),
      ).then((result) => {
        setSaveAllProgress((progress) => ({
          ...progress,
          completed: progress.completed + 1,
          failed: result.ok ? progress.failed : [...progress.failed, result.documentId],
        }));
        return result;
      });
    });
    const results = await Promise.all(writes);
    const failed: Array<BusinessDataDocumentId | 'manifest.json'> = results.filter((result) => !result.ok).map((result) => result.documentId);
    if (failed.length === 0) {
      try {
        await enqueueWork(() => transport.putArchiveDocument(APP_ID, 'manifest.json', BUSINESS_DATA_MANIFEST as unknown as ArchiveJsonValue));
      } catch {
        failed.push('manifest.json');
      }
    }
    setSaveAllProgress({ status: failed.length === 0 ? 'succeeded' : 'failed', completed: 5, total: 5, failed });
    return { failed };
  }, [enqueueDocument, enqueueWork, requireWorking, transport]);

  const importBusinessData = useCallback((value: unknown) => {
    const next = parseBusinessDataV1(value);
    workingRef.current = next;
    setData(next);
    for (const documentId of BUSINESS_DATA_DOCUMENT_IDS) {
      const generation = documentsRef.current[documentId].generation + 1;
      replaceDocumentState(documentId, (state) => ({ ...state, dirty: true, error: null, generation }));
    }
    return saveAll();
  }, [replaceDocumentState, saveAll]);

  const exportBusinessData = useCallback(() => `${JSON.stringify(requireWorking(), null, 2)}\n`, [requireWorking]);

  const downloadBusinessData = useCallback((filename = 'flightarchive-business-data.json') => {
    const url = URL.createObjectURL(new Blob([exportBusinessData()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }, [exportBusinessData]);

  const reload = useCallback(async (options: { discardChanges?: boolean } = {}) => {
    const dirty = BUSINESS_DATA_DOCUMENT_IDS.some((id) => documentsRef.current[id].dirty);
    if (dirty && !options.discardChanges) throw new DirtyBusinessDataError();
    if (options.discardChanges) await queueRef.current;
    const generations = BUSINESS_DATA_DOCUMENT_IDS.map((id) => documentsRef.current[id].generation);
    const queueActivity = queueActivityRef.current;
    setPhase('loading');
    setLoadError(null);
    try {
      const manifest = await transport.getArchiveDocument(APP_ID, 'manifest.json');
      parseBusinessDataManifest(manifest);
      const values = await Promise.all(BUSINESS_DATA_DOCUMENT_IDS.map((id) => transport.getArchiveDocument(APP_ID, id)));
      const changedWhileLoading = queueActivityRef.current !== queueActivity
        || BUSINESS_DATA_DOCUMENT_IDS.some((id, index) => documentsRef.current[id].generation !== generations[index]);
      const newlyDirty = !options.discardChanges && BUSINESS_DATA_DOCUMENT_IDS.some((id) => documentsRef.current[id].dirty);
      if (changedWhileLoading || newlyDirty) {
        throw new DirtyBusinessDataError();
      }
      const split = Object.fromEntries(BUSINESS_DATA_DOCUMENT_IDS.map((id, index) => [id, values[index]])) as BusinessDataDocuments;
      const loaded = aggregateBusinessData(split);
      const clean = cleanDocumentStates();
      documentsRef.current = clean;
      setDocuments(clean);
      workingRef.current = loaded;
      setData(loaded);
      setPhase('ready');
    } catch (reason) {
      const error = errorFrom(reason);
      setLoadError(error);
      setPhase('error');
      throw error;
    }
  }, [transport]);

  useEffect(() => { void reload().catch(() => undefined); }, [reload]);

  const value = useMemo<BusinessDataContextValue>(() => ({
    phase, data, loadError, documents, saveAllProgress,
    createFlight, updateFlight, deleteFlight, upsertCatalogEntry, deleteCatalogEntries, updateSettings,
    retryDocument, saveDocument, saveAll, importBusinessData, exportBusinessData, downloadBusinessData, reload,
    whenIdle: () => queueRef.current,
  }), [
    createFlight, data, deleteCatalogEntries, deleteFlight, documents, downloadBusinessData, exportBusinessData,
    importBusinessData, loadError, phase, reload, retryDocument, saveDocument, saveAll, saveAllProgress, updateFlight,
    updateSettings, upsertCatalogEntry,
  ]);

  return <BusinessDataContext.Provider value={value}>{children}</BusinessDataContext.Provider>;
}

export function useBusinessData(): BusinessDataContextValue {
  const value = useContext(BusinessDataContext);
  if (!value) throw new Error('useBusinessData must be used inside BusinessDataProvider');
  return value;
}
