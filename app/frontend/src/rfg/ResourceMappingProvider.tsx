// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import {
  HASH_ALGORITHMS, rfgClient, type HashAlgorithm, type LocalCatalog, type MappingDocument, type RfgClient,
} from './api';
import {
  applyFingerprints, autoMatchMappings, ignoreMappings, materializeMapping, reconcileMapping,
  releaseMappings, rematchMappings, resourceInventory, unignoreMappings, validateBatch,
  type AutoMatchAlgorithm, type RematchSelection, type ResourceInventoryRow, type VerifiedFingerprint,
} from './mapping';

export interface FingerprintProgress {
  session: number;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  completed: number;
  succeeded: number;
  failed: number;
  total: number;
}

export interface AutoRematchResult { applied: number; ambiguous: string[]; unmatched: string[] }

export interface ResourceMappingContextValue {
  catalog: LocalCatalog | null;
  mapping: MappingDocument | null;
  inventory: ResourceInventoryRow[];
  loading: boolean;
  error: Error | null;
  fingerprintProgress: FingerprintProgress;
  refresh(): Promise<void>;
  reconcile(): Promise<void>;
  materialize(inboxPath: string, stablePath: string): Promise<void>;
  release(paths: readonly string[]): Promise<void>;
  ignore(paths: readonly string[]): Promise<void>;
  unignore(paths: readonly string[]): Promise<void>;
  rematch(selections: readonly RematchSelection[]): Promise<void>;
  autoRematch(targetPaths: readonly string[], candidatePaths: readonly string[], algorithms: readonly AutoMatchAlgorithm[], signal?: AbortSignal): Promise<AutoRematchResult>;
  fingerprint(paths: readonly string[], algorithms: readonly HashAlgorithm[]): Promise<FingerprintProgress>;
  cancelFingerprint(): void;
}

const IDLE_PROGRESS: FingerprintProgress = { session: 0, status: 'idle', completed: 0, succeeded: 0, failed: 0, total: 0 };
const ResourceMappingContext = createContext<ResourceMappingContextValue | null>(null);

function asError(reason: unknown): Error { return reason instanceof Error ? reason : new Error(String(reason)); }
function changed(left: MappingDocument, right: MappingDocument): boolean { return JSON.stringify(left) !== JSON.stringify(right); }

export function ResourceMappingProvider({ children, client = rfgClient }: { children: ReactNode; client?: RfgClient }) {
  const [catalog, setCatalog] = useState<LocalCatalog | null>(null);
  const [mapping, setMapping] = useState<MappingDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [fingerprintProgress, setFingerprintProgress] = useState<FingerprintProgress>(IDLE_PROGRESS);
  const mounted = useRef(true);
  const fingerprintController = useRef<AbortController | null>(null);
  const fingerprintSession = useRef(0);

  const publish = useCallback((nextCatalog: LocalCatalog, nextMapping: MappingDocument) => {
    if (!mounted.current) return;
    setCatalog(nextCatalog); setMapping(nextMapping);
  }, []);

  const fresh = useCallback(async (signal?: AbortSignal) => {
    const nextCatalog = await client.getCatalog(signal);
    const snapshot = await client.getMapping(signal);
    return { catalog: nextCatalog, mapping: snapshot.document };
  }, [client]);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const current = await fresh();
      publish(current.catalog, current.mapping);
    } catch (reason) {
      if (mounted.current) setError(asError(reason));
      throw reason;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [fresh, publish]);

  const mutate = useCallback(async (transform: (document: MappingDocument, catalog: LocalCatalog) => MappingDocument) => {
    setLoading(true); setError(null);
    try {
      const current = await fresh();
      const next = transform(current.mapping, current.catalog);
      if (changed(current.mapping, next)) await client.putMapping(next);
      const latest = await client.getMapping();
      publish(current.catalog, latest.document);
    } catch (reason) {
      if (mounted.current) setError(asError(reason));
      throw reason;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [client, fresh, publish]);

  const reconcile = useCallback(() => mutate(reconcileMapping), [mutate]);
  const materialize = useCallback((inboxPath: string, stablePath: string) => mutate((document, local) => materializeMapping(document, local, inboxPath, stablePath)), [mutate]);
  const release = useCallback((paths: readonly string[]) => mutate((document, local) => releaseMappings(document, local, paths)), [mutate]);
  const ignore = useCallback((paths: readonly string[]) => mutate((document, local) => ignoreMappings(document, local, paths)), [mutate]);
  const unignore = useCallback((paths: readonly string[]) => mutate((document, local) => unignoreMappings(document, local, paths)), [mutate]);
  const rematch = useCallback((selections: readonly RematchSelection[]) => mutate((document, local) => rematchMappings(document, local, selections)), [mutate]);

  const autoRematch = useCallback(async (
    targetPaths: readonly string[], candidatePaths: readonly string[], algorithms: readonly AutoMatchAlgorithm[], signal?: AbortSignal,
  ): Promise<AutoRematchResult> => {
    setLoading(true); setError(null);
    try {
      validateBatch(targetPaths, 'target paths'); validateBatch(candidatePaths, 'candidate paths');
      const current = await fresh(signal);
      const byVirtual = new Map(current.mapping.entries.map((entry) => [entry.virtual_path, entry]));
      const candidateSources = new Map<string, string>();
      const hashes: Record<string, Partial<Record<HashAlgorithm, string>>> = {};
      const selectedHashes = algorithms.filter((item): item is HashAlgorithm => HASH_ALGORITHMS.includes(item as HashAlgorithm));
      for (const path of candidatePaths) {
        const entry = byVirtual.get(path);
        if (!entry) throw new Error(`mapping not found: ${path}`);
        candidateSources.set(path, entry.local_path);
        hashes[path] = {};
        for (const algorithm of selectedHashes) {
          const result = await client.computeHash({ local_path: entry.local_path, algorithm }, signal);
          if (result.status === 'succeeded' && result.local_path === entry.local_path && result.algorithm === algorithm) hashes[path][algorithm] = result.value;
        }
      }
      const latestBeforeWrite = await fresh(signal);
      for (const path of candidatePaths) {
        const entry = latestBeforeWrite.mapping.entries.find((item) => item.virtual_path === path);
        if (!entry || entry.local_path !== candidateSources.get(path)) throw new Error(`rematch candidate changed while hashing: ${path}`);
      }
      const result = autoMatchMappings(latestBeforeWrite.mapping, latestBeforeWrite.catalog, targetPaths, candidatePaths, algorithms, hashes);
      if (result.applied) await client.putMapping(result.document, signal);
      const latest = await client.getMapping(signal);
      publish(latestBeforeWrite.catalog, latest.document);
      return { applied: result.applied, ambiguous: result.ambiguous, unmatched: result.unmatched };
    } catch (reason) {
      if (mounted.current && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(asError(reason));
      throw reason;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [client, fresh, publish]);

  const fingerprint = useCallback(async (paths: readonly string[], algorithms: readonly HashAlgorithm[]): Promise<FingerprintProgress> => {
    validateBatch(paths);
    if (!algorithms.length || new Set(algorithms).size !== algorithms.length || algorithms.some((item) => !HASH_ALGORITHMS.includes(item))) throw new Error('invalid fingerprint algorithms');
    fingerprintController.current?.abort();
    const controller = new AbortController(); fingerprintController.current = controller;
    const session = ++fingerprintSession.current;
    setError(null);
    const total = paths.length * algorithms.length;
    setFingerprintProgress({ session, status: 'running', completed: 0, succeeded: 0, failed: 0, total });
    const completed: VerifiedFingerprint[] = [];
    let done = 0; let succeeded = 0; let failed = 0;
    try {
      const current = await fresh(controller.signal);
      const entries = new Map(current.mapping.entries.map((entry) => [entry.virtual_path, entry]));
      const present = new Set(current.catalog.local_files.map((item) => item.local_path));
      // Preserve batch semantics: reject every invalid selection before starting any hash.
      for (const path of paths) {
        const entry = entries.get(path);
        if (!entry || entry.virtual_path.startsWith('inbox/') || entry.virtual_path.startsWith('ignore/') || !present.has(entry.local_path)) throw new Error('fingerprint targets must be present stable mappings');
      }
      for (const path of paths) {
        const entry = entries.get(path)!;
        for (const algorithm of algorithms) {
          if (controller.signal.aborted) break;
          try {
            const result = await client.computeHash({ local_path: entry.local_path, algorithm }, controller.signal);
            if (result.status === 'succeeded' && result.local_path === entry.local_path && result.algorithm === algorithm) {
              completed.push({ virtualPath: path, localPath: entry.local_path, algorithm, value: result.value }); succeeded += 1;
            } else failed += 1;
          } catch (reason) {
            if (controller.signal.aborted) break;
            failed += 1;
          }
          done += 1;
          if (mounted.current && fingerprintSession.current === session) setFingerprintProgress({ session, status: 'running', completed: done, succeeded, failed, total });
        }
        if (controller.signal.aborted) break;
      }
      if (completed.length) {
        const latest = await fresh(controller.signal);
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const next = applyFingerprints(latest.mapping, latest.catalog, completed);
        if (changed(latest.mapping, next)) await client.putMapping(next, controller.signal);
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const saved = await client.getMapping(controller.signal);
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        publish(latest.catalog, saved.document);
      }
      const outcome: FingerprintProgress = {
        session, status: controller.signal.aborted ? 'cancelled' : failed ? 'failed' : 'succeeded', completed: done, succeeded, failed, total,
      };
      if (mounted.current && fingerprintSession.current === session) setFingerprintProgress(outcome);
      return outcome;
    } catch (reason) {
      const cancelled = controller.signal.aborted;
      if (mounted.current && fingerprintSession.current === session) {
        setFingerprintProgress({ session, status: cancelled ? 'cancelled' : 'failed', completed: done, succeeded, failed: cancelled ? failed : failed + 1, total });
        if (!cancelled) setError(asError(reason));
      }
      if (!cancelled) throw reason;
      return { session, status: 'cancelled', completed: done, succeeded, failed, total };
    } finally {
      if (fingerprintController.current === controller) fingerprintController.current = null;
    }
  }, [client, fresh, publish]);

  const cancelFingerprint = useCallback(() => fingerprintController.current?.abort(), []);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => undefined);
    return () => { mounted.current = false; fingerprintController.current?.abort(); };
  }, [refresh]);

  const inventory = useMemo(() => mapping && catalog ? resourceInventory(mapping, catalog) : [], [mapping, catalog]);
  const value = useMemo<ResourceMappingContextValue>(() => ({
    catalog, mapping, inventory, loading, error, fingerprintProgress,
    refresh, reconcile, materialize, release, ignore, unignore, rematch, autoRematch, fingerprint, cancelFingerprint,
  }), [catalog, mapping, inventory, loading, error, fingerprintProgress, refresh, reconcile, materialize, release, ignore, unignore, rematch, autoRematch, fingerprint, cancelFingerprint]);
  return <ResourceMappingContext.Provider value={value}>{children}</ResourceMappingContext.Provider>;
}

export function useResourceMapping(): ResourceMappingContextValue {
  const value = useContext(ResourceMappingContext);
  if (!value) throw new Error('useResourceMapping must be used inside ResourceMappingProvider');
  return value;
}
