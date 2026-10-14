// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import {
  HASH_ALGORITHMS, rfgClient, type HashAlgorithm, type LocalCatalog, type MappingDocument, type MappingEntry, type RfgClient,
} from './api';
import {
  applyFingerprints, autoMatchMappings, ignoreMappings, isInboxPath, reconcileMapping,
  releaseMappings, rematchMappings, resolveMappingTransitions, resourceInventory, transitionMappings, unignoreMappings, validateBatch, validateMapping,
  type AutoMatchAlgorithm, type MappingTransition, type RematchSelection, type ResourceInventoryRow, type VerifiedFingerprint,
} from './mapping';
import { useOptionalFeedback } from '../feedback/FeedbackCenter';

export interface FingerprintProgress {
  session: number;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  completed: number;
  succeeded: number;
  failed: number;
  total: number;
}

export interface AutoRematchResult { applied: number; ambiguous: string[]; unmatched: string[] }
export interface MappingRecoveryChange {
  localPath: string;
  before: MappingEntry;
  expectedAfter: MappingEntry | null;
  operation: 'rename' | 'release';
}
export interface MappingRecoveryReceipt { changes: MappingRecoveryChange[] }
export interface ResourceTransitionResult { recovery: MappingRecoveryReceipt; attempts: number; retargets: MappingTransition[] }
export type ResourceCompensationState = 'not-needed' | 'restored' | 'failed';
export class ResourceMappingMutationError extends Error {
  constructor(message: string, public readonly attempts: number, public readonly compensationState: ResourceCompensationState, options?: ErrorOptions) {
    super(message, options); this.name = 'ResourceMappingMutationError';
  }
}

export interface ResourceMappingContextValue {
  catalog: LocalCatalog | null;
  mapping: MappingDocument | null;
  inventory: ResourceInventoryRow[];
  loading: boolean;
  error: Error | null;
  fingerprintProgress: FingerprintProgress;
  refresh(): Promise<void>;
  reconcile(): Promise<void>;
  release(paths: readonly string[], authorize?: () => void): Promise<void>;
  transition(transitions: readonly MappingTransition[]): Promise<ResourceTransitionResult>;
  restore(recovery: MappingRecoveryReceipt): Promise<void>;
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
function cloneEntry(entry: MappingEntry): MappingEntry { return { ...entry }; }

function recoveryReceipt(before: MappingDocument, after: MappingDocument, transitions: readonly MappingTransition[]): MappingRecoveryReceipt {
  return { changes: transitions.map((transition) => {
    const prior = before.entries.find((entry) => entry.virtual_path === transition.from)!;
    const expectedAfter = after.entries.find((entry) => entry.local_path === prior.local_path) ?? null;
    return {
      localPath: prior.local_path,
      before: cloneEntry(prior),
      expectedAfter: expectedAfter ? cloneEntry(expectedAfter) : null,
      operation: transition.to === null ? 'release' : 'rename',
    };
  }) };
}

/** Reverses only entries changed by one coordinated operation. */
function applyRecovery(current: MappingDocument, recovery: MappingRecoveryReceipt): MappingDocument {
  validateMapping(current);
  const next: MappingDocument = { entries: current.entries.map(cloneEntry) };
  for (const change of recovery.changes) {
    const byLocal = next.entries.find((entry) => entry.local_path === change.localPath);
    const expectedVirtual = change.expectedAfter?.virtual_path;
    if (byLocal?.virtual_path === change.before.virtual_path) continue;
    const safeExpected = byLocal && (
      byLocal.virtual_path === expectedVirtual
      || (change.operation === 'release' && change.expectedAfter === null && isInboxPath(byLocal.virtual_path))
    );
    if (!safeExpected && !(change.operation === 'release' && change.expectedAfter === null && !byLocal)) {
      throw new Error(`mapping recovery conflict for source: ${change.localPath}`);
    }
    const occupied = next.entries.find((entry) => entry.virtual_path === change.before.virtual_path && entry.local_path !== change.localPath);
    if (occupied) throw new Error(`mapping recovery path collision: ${change.before.virtual_path}`);
    if (byLocal) {
      const replacement = change.operation === 'rename'
        ? { ...byLocal, virtual_path: change.before.virtual_path }
        : cloneEntry(change.before);
      next.entries[next.entries.indexOf(byLocal)] = replacement;
    } else {
      next.entries.push(cloneEntry(change.before));
    }
  }
  validateMapping(next);
  return next;
}

export function ResourceMappingProvider({ children, client = rfgClient }: { children: ReactNode; client?: RfgClient }) {
  const reportFailure = useOptionalFeedback()?.reportFailure;
  const [catalog, setCatalog] = useState<LocalCatalog | null>(null);
  const [mapping, setMapping] = useState<MappingDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [fingerprintProgress, setFingerprintProgress] = useState<FingerprintProgress>(IDLE_PROGRESS);
  const mounted = useRef(true);
  const fingerprintController = useRef<AbortController | null>(null);
  const fingerprintSession = useRef(0);
  const pendingRecovery = useRef<MappingRecoveryReceipt | null>(null);
  const restoreRecoveryRef = useRef<(recovery: MappingRecoveryReceipt) => Promise<number>>(async () => { throw new Error('mapping recovery is unavailable'); });
  const mappingWork = useRef<Promise<void>>(Promise.resolve());
  const startupStarted = useRef(false);

  const serializeMappingWork = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const result = mappingWork.current.then(work, work);
    mappingWork.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const publish = useCallback((nextCatalog: LocalCatalog, nextMapping: MappingDocument) => {
    if (!mounted.current) return;
    setCatalog(nextCatalog); setMapping(nextMapping);
  }, []);

  const fresh = useCallback(async (signal?: AbortSignal) => {
    const nextCatalog = await client.getCatalog(signal);
    const snapshot = await client.getMapping(signal);
    validateMapping(snapshot.document);
    return { catalog: nextCatalog, mapping: snapshot.document };
  }, [client]);

  const confirmMapping = useCallback(async (expected: MappingDocument, signal?: AbortSignal) => {
    const saved = (await client.getMapping(signal)).document;
    validateMapping(saved);
    if (changed(saved, expected)) throw new Error('mapping changed unexpectedly after write');
    return saved;
  }, [client]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await serializeMappingWork(async () => {
        // Recovery is an internal precondition of the user's next ordinary
        // action, never a separate workflow or button.
        if (pendingRecovery.current) await restoreRecoveryRef.current(pendingRecovery.current);
        const current = await fresh();
        const next = reconcileMapping(current.mapping, current.catalog);
        if (!changed(current.mapping, next)) {
          publish(current.catalog, current.mapping);
          return;
        }
        await client.putMapping(next);
        const saved = await confirmMapping(next);
        publish(current.catalog, saved);
      });
      if (mounted.current && !pendingRecovery.current) setError(null);
    } catch (reason) {
      if (mounted.current) setError(asError(reason));
      throw reason;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [client, confirmMapping, fresh, publish, serializeMappingWork]);

  const mutate = useCallback(async (transform: (document: MappingDocument, catalog: LocalCatalog) => MappingDocument, authorize?: () => void) => {
    setLoading(true);
    try {
      await serializeMappingWork(async () => {
        if (pendingRecovery.current) await restoreRecoveryRef.current(pendingRecovery.current);
        const current = await fresh();
        authorize?.();
        const next = reconcileMapping(transform(current.mapping, current.catalog), current.catalog);
        if (!changed(current.mapping, next)) {
          publish(current.catalog, current.mapping);
          return;
        }
        await client.putMapping(next);
        const saved = await confirmMapping(next);
        publish(current.catalog, saved);
      });
      if (mounted.current) setError(null);
    } catch (reason) {
      if (mounted.current) setError(asError(reason));
      throw reason;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [client, confirmMapping, fresh, publish, serializeMappingWork]);

  const reconcile = useCallback(() => mutate(reconcileMapping), [mutate]);
  const release = useCallback((paths: readonly string[], authorize?: () => void) => mutate((document, local) => releaseMappings(document, local, paths), authorize), [mutate]);
  const restoreRecovery = useCallback(async (recovery: MappingRecoveryReceipt): Promise<number> => {
    let writes = 0; let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let current: MappingDocument | null = null;
      try {
        current = (await client.getMapping()).document;
        validateMapping(current);
      } catch (reason) { last = reason; }
      if (!current) break;
      let restored: MappingDocument;
      try { restored = applyRecovery(current, recovery); } catch (reason) {
        pendingRecovery.current = recovery;
         throw new ResourceMappingMutationError('mapping recovery conflicts with a later resource change', writes, 'failed', { cause: reason });
      }
      if (!changed(current, restored)) {
        pendingRecovery.current = null;
        if (mounted.current) setMapping(current);
        return writes;
      }
      writes++;
      let writeResolved = false;
      try { await client.putMapping(restored); writeResolved = true; } catch (reason) { last = reason; }
      let observed: MappingDocument | null = null;
      for (let readAttempt = 1; readAttempt <= 3; readAttempt++) {
        try {
          observed = (await client.getMapping()).document;
          validateMapping(observed);
          break;
        } catch (reason) { last = reason; }
      }
      if (observed) {
        try {
          const remaining = applyRecovery(observed, recovery);
          if (!changed(observed, remaining)) {
            pendingRecovery.current = null;
            if (mounted.current) setMapping(observed);
            return writes;
          }
        } catch (reason) { last = reason; break; }
      }
      // A resolved restore PUT followed only by failed reads must not trigger
      // blind repeated writes. Keep the recovery receipt for the next user retry.
      if (writeResolved && observed === null) break;
    }
    pendingRecovery.current = recovery;
     throw new ResourceMappingMutationError('mapping compensation could not be confirmed', writes, 'failed', { cause: last });
   }, [client]);
   restoreRecoveryRef.current = restoreRecovery;

  const transition = useCallback(async (transitions: readonly MappingTransition[]) => {
    setLoading(true);
    let attempts = 0; let before: MappingDocument | null = null; let last: unknown;
    try {
      const result = await serializeMappingWork(async () => {
       if (pendingRecovery.current) await restoreRecovery(pendingRecovery.current);
       const current = await fresh();
       before = { entries: current.mapping.entries.map((entry) => ({ ...entry })) };
        const retargets = resolveMappingTransitions(current.mapping, transitions);
        const next = reconcileMapping(transitionMappings(current.mapping, current.catalog, retargets), current.catalog);
        const recovery = recoveryReceipt(before, next, retargets);
        if (!changed(before, next)) return { recovery, attempts: 0, retargets };
      for (let attempt = 1; attempt <= 3; attempt++) {
        attempts++;
        try {
          await client.putMapping(next);
          let latest: MappingDocument | null = null;
          for (let readAttempt = 1; readAttempt <= 3; readAttempt++) {
            try { latest = (await client.getMapping()).document; break; } catch (reason) { last = reason; }
          }
          if (!latest) {
            let compensation: ResourceCompensationState = 'restored';
             try { await restoreRecovery(recovery); } catch { compensation = 'failed'; }
            throw new ResourceMappingMutationError('mapping write succeeded but confirmation failed', attempts, compensation, { cause: last });
          }
          if (changed(latest, next)) {
            let compensation: ResourceCompensationState = 'restored';
             try { await restoreRecovery(recovery); } catch { compensation = 'failed'; }
            throw new ResourceMappingMutationError('mapping changed unexpectedly after write', attempts, compensation);
          }
          publish(current.catalog, latest);
            return { recovery, attempts, retargets };
        } catch (reason) {
          if (reason instanceof ResourceMappingMutationError) throw reason;
          last = reason;
          // A rejected response is ambiguous: observe before deciding whether
          // another operation PUT is safe.
          let observed: MappingDocument | null = null;
          try { observed = (await client.getMapping()).document; } catch { /* compensate below */ }
            if (observed && !changed(observed, next)) { publish(current.catalog, observed); return { recovery, attempts, retargets }; }
          if (observed && !changed(observed, before)) continue;
          let compensation: ResourceCompensationState = 'restored';
           try { await restoreRecovery(recovery); } catch { compensation = 'failed'; }
          if (compensation === 'restored' && attempt < 3) continue;
          throw new ResourceMappingMutationError('mapping write failed', attempts, compensation, { cause: reason });
        }
      }
      throw new ResourceMappingMutationError('mapping write failed', attempts, 'not-needed', { cause: last });
      });
      if (mounted.current) setError(null);
      return result;
    } catch (reason) {
      if (mounted.current) setError(asError(reason));
      throw reason;
    } finally { if (mounted.current) setLoading(false); }
   }, [client, fresh, publish, restoreRecovery, serializeMappingWork]);
   const restore = useCallback(async (recovery: MappingRecoveryReceipt) => {
     setLoading(true);
     try {
       await serializeMappingWork(() => restoreRecovery(recovery));
      if (mounted.current) setError(null);
    } catch (reason) {
      if (mounted.current) setError(asError(reason));
      throw reason;
    } finally { if (mounted.current) setLoading(false); }
   }, [restoreRecovery, serializeMappingWork]);
  const ignore = useCallback((paths: readonly string[]) => mutate((document, local) => ignoreMappings(document, local, paths)), [mutate]);
  const unignore = useCallback((paths: readonly string[]) => mutate((document, local) => unignoreMappings(document, local, paths)), [mutate]);
  const rematch = useCallback((selections: readonly RematchSelection[]) => mutate((document, local) => rematchMappings(document, local, selections)), [mutate]);

  const autoRematch = useCallback(async (
    targetPaths: readonly string[], candidatePaths: readonly string[], algorithms: readonly AutoMatchAlgorithm[], signal?: AbortSignal,
  ): Promise<AutoRematchResult> => {
    setLoading(true);
    try {
      await serializeMappingWork(async () => { if (pendingRecovery.current) await restoreRecoveryRef.current(pendingRecovery.current); });
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
      const result = await serializeMappingWork(async () => {
         if (pendingRecovery.current) await restoreRecoveryRef.current(pendingRecovery.current);
        const latestBeforeWrite = await fresh(signal);
        for (const path of candidatePaths) {
          const entry = latestBeforeWrite.mapping.entries.find((item) => item.virtual_path === path);
          if (!entry || entry.local_path !== candidateSources.get(path)) throw new Error(`rematch candidate changed while hashing: ${path}`);
        }
        const result = autoMatchMappings(latestBeforeWrite.mapping, latestBeforeWrite.catalog, targetPaths, candidatePaths, algorithms, hashes);
        const next = reconcileMapping(result.document, latestBeforeWrite.catalog);
        if (changed(latestBeforeWrite.mapping, next)) {
          await client.putMapping(next, signal);
          const saved = await confirmMapping(next, signal);
          publish(latestBeforeWrite.catalog, saved);
        } else {
          publish(latestBeforeWrite.catalog, latestBeforeWrite.mapping);
        }
        return { applied: result.applied, ambiguous: result.ambiguous, unmatched: result.unmatched };
      });
      if (mounted.current) setError(null);
      return result;
    } catch (reason) {
      if (mounted.current && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(asError(reason));
      throw reason;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [client, confirmMapping, fresh, publish, serializeMappingWork]);

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
      await serializeMappingWork(async () => { if (pendingRecovery.current) await restoreRecoveryRef.current(pendingRecovery.current); });
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
      if (!controller.signal.aborted) {
        await serializeMappingWork(async () => {
           if (pendingRecovery.current) await restoreRecoveryRef.current(pendingRecovery.current);
          const latest = await fresh(controller.signal);
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const next = reconcileMapping(applyFingerprints(latest.mapping, latest.catalog, completed), latest.catalog);
          if (changed(latest.mapping, next)) {
            await client.putMapping(next, controller.signal);
            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const saved = await confirmMapping(next, controller.signal);
            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            publish(latest.catalog, saved);
            return;
          }
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          publish(latest.catalog, latest.mapping);
        });
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
  }, [client, confirmMapping, fresh, publish, serializeMappingWork]);

  const cancelFingerprint = useCallback(() => fingerprintController.current?.abort(), []);

  useEffect(() => {
    mounted.current = true;
    if (!startupStarted.current) {
      startupStarted.current = true;
      void refresh().catch((reason) => {
        if (!mounted.current) return;
        reportFailure?.(reason, {
          code: 'resource-mapping-failed',
          activity: { source: 'frontend-resources', kind: 'mapping', severity: 'error', state: 'failed', code: 'resource-mapping-failed', details: { operation: 'startup-refresh' } },
        });
      });
    }
    return () => { mounted.current = false; fingerprintController.current?.abort(); };
  }, [refresh, reportFailure]);

  const inventory = useMemo(() => mapping && catalog ? resourceInventory(mapping, catalog) : [], [mapping, catalog]);
  const value = useMemo<ResourceMappingContextValue>(() => ({
    catalog, mapping, inventory, loading, error, fingerprintProgress,
    refresh, reconcile, release, transition, restore, ignore, unignore, rematch, autoRematch, fingerprint, cancelFingerprint,
  }), [catalog, mapping, inventory, loading, error, fingerprintProgress, refresh, reconcile, release, transition, restore, ignore, unignore, rematch, autoRematch, fingerprint, cancelFingerprint]);
  return <ResourceMappingContext.Provider value={value}>{children}</ResourceMappingContext.Provider>;
}

export function useResourceMapping(): ResourceMappingContextValue {
  const value = useContext(ResourceMappingContext);
  if (!value) throw new Error('useResourceMapping must be used inside ResourceMappingProvider');
  return value;
}

export function useOptionalResourceMapping(): ResourceMappingContextValue | null {
  return useContext(ResourceMappingContext);
}
