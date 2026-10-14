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
import { referencesByResource } from './resourceReferences';
import type { AircraftType, Airline, Airport, BusinessData, CatalogKind, FlightRecord } from './types';
import { useOptionalFeedback } from '../feedback/FeedbackCenter';

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

export interface PreparedBusinessMutation<T> {
  before: BusinessData;
  next: BusinessData;
  result: T;
}

export class PreparedCommitError extends Error {
  constructor(message: string, public readonly rollbackFailedDocs: BusinessDataDocumentId[], options?: ErrorOptions) {
    super(message, options); this.name = 'PreparedCommitError';
  }
}

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
  prepareCreateFlight(input: unknown): PreparedBusinessMutation<FlightRecord>;
  prepareUpdateFlight(id: string, changes: unknown): PreparedBusinessMutation<FlightRecord>;
  prepareDeleteFlight(id: string): PreparedBusinessMutation<FlightRecord>;
  prepareUpsertCatalogEntry(kind: CatalogKind, key: string, changes: unknown): PreparedBusinessMutation<CatalogEntry>;
  prepareDeleteCatalogEntries(kind: CatalogKind, keys: readonly string[], force?: boolean): PreparedBusinessMutation<CatalogEntry[]>;
  commitPrepared<T>(mutation: PreparedBusinessMutation<T>): Promise<T>;
  retryDocument(documentId: BusinessDataDocumentId): Promise<DocumentSaveResult>;
  saveDocument(documentId: BusinessDataDocumentId): Promise<DocumentSaveResult>;
  saveAll(): Promise<SaveAllResult>;
  importBusinessData(value: unknown): Promise<SaveAllResult>;
  exportBusinessData(): string;
  downloadBusinessData(filename?: string): void;
  reload(options?: { discardChanges?: boolean }): Promise<void>;
  whenIdle(): Promise<void>;
  hasResourceReferences(paths: readonly string[]): boolean;
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
  const reportFailure = useOptionalFeedback()?.reportFailure;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [data, setData] = useState<BusinessData | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [documents, setDocuments] = useState(cleanDocumentStates);
  const [saveAllProgress, setSaveAllProgress] = useState<SaveAllProgress>({ status: 'idle', completed: 0, total: 5, failed: [] });
  const workingRef = useRef<BusinessData | null>(null);
  const documentsRef = useRef(documents);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const queueActivityRef = useRef(0);
  const mountedRef = useRef(true);
  const startupStartedRef = useRef(false);
  const loadGenerationRef = useRef(0);

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

  const enqueueDocument = useCallback((documentId: BusinessDataDocumentId, snapshot: unknown, generation: number, publishFailure = true): Promise<DocumentSaveResult> => {
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
        if (publishFailure) reportFailure?.(error, {
          code: 'archive-document-save-failed',
          activity: {
            source: 'frontend-business-data', kind: 'persistence', severity: 'error', state: 'failed', code: 'archive-document-save-failed',
            details: { documentId, message: error.message },
          },
        });
        throw error;
      } finally {
        replaceDocumentState(documentId, (state) => ({ ...state, pending: Math.max(0, state.pending - 1), saving: state.pending > 1 }));
      }
    });
  }, [enqueueWork, replaceDocumentState, reportFailure, transport]);

  const requireWorking = useCallback((): BusinessData => {
    if (!workingRef.current) throw new Error('business data is not loaded');
    return workingRef.current;
  }, []);

  const hasResourceReferences = useCallback((paths: readonly string[]) => {
    const references = referencesByResource(requireWorking());
    return paths.some((path) => (references.get(path)?.length ?? 0) > 0);
  }, [requireWorking]);

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

  const prepareCreateFlight = useCallback((input: unknown): PreparedBusinessMutation<FlightRecord> => {
    const before = requireWorking(); const next = createFlightCommand(before, input, dependencies, { inboxDraft: true });
    return { before, next, result: next.flights.at(-1)! };
  }, [dependencies, requireWorking]);
  const prepareUpdateFlight = useCallback((id: string, changes: unknown): PreparedBusinessMutation<FlightRecord> => {
    const before = requireWorking(); const next = updateFlightCommand(before, id, changes, dependencies, { inboxDraft: true });
    return { before, next, result: next.flights.find((flight) => flight.id === id)! };
  }, [dependencies, requireWorking]);
  const prepareDeleteFlight = useCallback((id: string): PreparedBusinessMutation<FlightRecord> => {
    const before = requireWorking(); const deleted = before.flights.find((flight) => flight.id === id);
    if (!deleted) { deleteFlightCommand(before, id); throw new Error('unreachable'); }
    return { before, next: deleteFlightCommand(before, id), result: deleted };
  }, [requireWorking]);
  const prepareUpsertCatalogEntry = useCallback((kind: CatalogKind, key: string, changes: unknown): PreparedBusinessMutation<CatalogEntry> => {
    const before = requireWorking(); const next = upsertCatalogEntryCommand(before, kind, key, changes, { inboxDraft: true });
    const normalizedKey = key.trim().toUpperCase();
    return { before, next, result: catalogEntries(next, kind).find((entry) => ('code' in entry ? entry.code : entry.icao) === normalizedKey)! };
  }, [requireWorking]);
  const prepareDeleteCatalogEntries = useCallback((kind: CatalogKind, keys: readonly string[], force = false): PreparedBusinessMutation<CatalogEntry[]> => {
    const before = requireWorking(); const normalized = new Set(keys.map((key) => key.trim().toUpperCase()));
    const result = catalogEntries(before, kind).filter((entry) => normalized.has('code' in entry ? entry.code : entry.icao));
    return { before, next: deleteCatalogEntriesCommand(before, kind, keys, force), result };
  }, [requireWorking]);

  const commitPrepared = useCallback(async <T,>(mutation: PreparedBusinessMutation<T>): Promise<T> => {
    // Prepared mutations may temporarily carry confirmed inbox selections, but
    // coordination must retarget every one before persistence.
    parseBusinessDataV1(mutation.next);
    const beforeDocuments = splitBusinessData(mutation.before), nextDocuments = splitBusinessData(mutation.next);
    const affected = BUSINESS_DATA_DOCUMENT_IDS.filter((id) => JSON.stringify(beforeDocuments[id]) !== JSON.stringify(nextDocuments[id]));
    if (!affected.length) return mutation.result;
    queueActivityRef.current += 1;
    for (const documentId of affected) replaceDocumentState(documentId, (state) => ({ ...state, pending: state.pending + 1 }));
    await enqueueWork(async () => {
      const initialStates = Object.fromEntries(affected.map((id) => [id, documentsRef.current[id]])) as Partial<Record<BusinessDataDocumentId, DocumentPersistenceState>>;
      const attempted: BusinessDataDocumentId[] = [];
      for (const documentId of affected) replaceDocumentState(documentId, (state) => ({ ...state, saving: true }));
      try {
        if (workingRef.current !== mutation.before) throw new Error('business data changed while the operation was queued');
        for (const documentId of affected) {
          attempted.push(documentId);
          await transport.putArchiveDocument(APP_ID, documentId, structuredClone(nextDocuments[documentId]) as ArchiveJsonValue);
          if (workingRef.current !== mutation.before) throw new Error('business data changed while the prepared operation was saving');
        }
        if (workingRef.current !== mutation.before) throw new Error('business data changed before the prepared operation could publish');
        workingRef.current = mutation.next; setData(mutation.next);
        for (const documentId of affected) {
          const initial = initialStates[documentId]!;
          replaceDocumentState(documentId, (state) => ({
            ...state,
            // The exact prepared snapshot was confirmed written and no
            // competing working aggregate was allowed to publish. A previous
            // failure on this document is therefore resolved by this save.
            dirty: false,
            error: null,
            generation: Math.max(state.generation, initial.generation) + 1,
          }));
        }
      } catch (reason) {
        const error = errorFrom(reason);
        const rollbackFailedDocs: BusinessDataDocumentId[] = [];
        for (const documentId of [...attempted].reverse()) {
          try { await transport.putArchiveDocument(APP_ID, documentId, structuredClone(beforeDocuments[documentId]) as ArchiveJsonValue); }
          catch (rollbackReason) {
            const rollbackError = errorFrom(rollbackReason); rollbackFailedDocs.push(documentId);
            replaceDocumentState(documentId, (state) => ({ ...state, dirty: true, error: rollbackError }));
          }
        }
        throw new PreparedCommitError(error.message, rollbackFailedDocs, { cause: error });
      } finally {
        for (const documentId of affected) replaceDocumentState(documentId, (state) => ({ ...state, pending: Math.max(0, state.pending - 1), saving: state.pending > 1 }));
      }
    });
    return mutation.result;
  }, [enqueueWork, replaceDocumentState, transport]);

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
      return enqueueDocument(documentId, snapshots[documentId], generation, false).then(
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
    const loadGeneration = ++loadGenerationRef.current;
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
      if (!mountedRef.current || loadGeneration !== loadGenerationRef.current) return;
      const clean = cleanDocumentStates();
      documentsRef.current = clean;
      setDocuments(clean);
      workingRef.current = loaded;
      setData(loaded);
      setPhase('ready');
    } catch (reason) {
      const error = errorFrom(reason);
      if (!mountedRef.current || loadGeneration !== loadGenerationRef.current) throw error;
      setLoadError(error);
      setPhase('error');
      if (!(error instanceof DirtyBusinessDataError)) reportFailure?.(error, {
        code: 'archive-load-failed',
        activity: {
          source: 'frontend-business-data', kind: 'persistence', severity: 'error', state: 'failed', code: 'archive-load-failed',
          details: { operation: 'load' },
        },
      });
      throw error;
    }
  }, [reportFailure, transport]);

  useEffect(() => {
    mountedRef.current = true;
    if (!startupStartedRef.current) {
      startupStartedRef.current = true;
      void reload().catch(() => undefined);
    }
    return () => { mountedRef.current = false; };
  }, [reload]);

  const value = useMemo<BusinessDataContextValue>(() => ({
    phase, data, loadError, documents, saveAllProgress,
    createFlight, updateFlight, deleteFlight, upsertCatalogEntry, deleteCatalogEntries, updateSettings,
    prepareCreateFlight, prepareUpdateFlight, prepareDeleteFlight, prepareUpsertCatalogEntry, prepareDeleteCatalogEntries, commitPrepared,
    retryDocument, saveDocument, saveAll, importBusinessData, exportBusinessData, downloadBusinessData, reload, hasResourceReferences,
    whenIdle: () => queueRef.current,
  }), [
    createFlight, data, deleteCatalogEntries, deleteFlight, documents, downloadBusinessData, exportBusinessData,
    hasResourceReferences, importBusinessData, loadError, phase, reload, retryDocument, saveDocument, saveAll, saveAllProgress, updateFlight,
    updateSettings, upsertCatalogEntry, prepareCreateFlight, prepareUpdateFlight, prepareDeleteFlight,
    prepareUpsertCatalogEntry, prepareDeleteCatalogEntries, commitPrepared,
  ]);

  return <BusinessDataContext.Provider value={value}>{children}</BusinessDataContext.Provider>;
}

export function useBusinessData(): BusinessDataContextValue {
  const value = useContext(BusinessDataContext);
  if (!value) throw new Error('useBusinessData must be used inside BusinessDataProvider');
  return value;
}
