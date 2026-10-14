// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

import {
  HASH_ALGORITHMS, type HashAlgorithm, type LocalCatalog, type MappingDocument, type MappingEntry,
} from './api';

export const MAX_MAPPING_BATCH = 256;
const TEMPORARY_PREFIXES = ['inbox/', 'ignore/'] as const;
const HASH_FIELDS = new Set<string>(HASH_ALGORITHMS);
const ENTRY_FIELDS = new Set(['virtual_path', 'local_path', 'size_bytes', ...HASH_ALGORITHMS]);

export type ResourceState = 'mapped' | 'pending' | 'ignored' | 'missing';
export interface ResourceInventoryRow {
  virtualPath: string;
  localPath: string;
  state: ResourceState;
  present: boolean;
  sizeBytes: number | null;
  entry: MappingEntry;
}
export interface VerifiedFingerprint {
  virtualPath: string;
  localPath: string;
  algorithm: HashAlgorithm;
  value: string;
}
export interface RematchSelection {
  targetVirtualPath: string;
  candidateVirtualPath: string;
  hashes?: Partial<Record<HashAlgorithm, string>>;
}
export interface MappingTransition { from: string; to: string | null }
export type AutoMatchAlgorithm = HashAlgorithm | 'filename' | 'sizeBytes';

function copy(document: MappingDocument): MappingDocument {
  return { entries: document.entries.map((entry) => ({ ...entry })) };
}

export function isSafeRelativePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && !path.includes('\0') && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function isInboxPath(path: string): boolean { return path.startsWith('inbox/'); }
export function isIgnoredPath(path: string): boolean { return path.startsWith('ignore/'); }
export function isTemporaryPath(path: string): boolean { return TEMPORARY_PREFIXES.some((prefix) => path.startsWith(prefix)); }
export function isStablePath(path: string): boolean { return isSafeRelativePath(path) && !isTemporaryPath(path); }

export function validateMapping(document: MappingDocument): void {
  if (!document || !Array.isArray(document.entries)) throw new Error('mapping entries must be an array');
  if (Object.keys(document).some((key) => key !== 'entries')) throw new Error('mapping document contains an unsupported field');
  const virtual = new Set<string>();
  const local = new Set<string>();
  for (const entry of document.entries) {
    if (Object.keys(entry).some((key) => !ENTRY_FIELDS.has(key))) throw new Error('mapping entry contains an unsupported field');
    if (!isSafeRelativePath(entry.virtual_path) || !isSafeRelativePath(entry.local_path)) throw new Error('mapping paths must be safe relative POSIX paths');
    if (virtual.has(entry.virtual_path)) throw new Error(`duplicate virtual path: ${entry.virtual_path}`);
    if (local.has(entry.local_path)) throw new Error(`duplicate local path: ${entry.local_path}`);
    if (entry.size_bytes !== undefined && entry.size_bytes !== null
      && (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0)) throw new Error('size_bytes must be a non-negative safe integer or null');
    for (const algorithm of HASH_ALGORITHMS) {
      const value = entry[algorithm];
      if (value !== undefined && value !== null && (typeof value !== 'string' || !value)) throw new Error(`${algorithm} must be non-empty or null`);
    }
    virtual.add(entry.virtual_path); local.add(entry.local_path);
  }
}

export function validateBatch(values: readonly string[], label = 'paths'): void {
  if (!values.length || values.length > MAX_MAPPING_BATCH) throw new Error(`${label} must contain 1 to ${MAX_MAPPING_BATCH} values`);
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
  if (!values.every(isSafeRelativePath)) throw new Error(`${label} must contain safe relative POSIX paths`);
}

function catalogMap(catalog: LocalCatalog): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of catalog.local_files) {
    if (!isSafeRelativePath(item.local_path) || !Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0) throw new Error('invalid local catalog entry');
    if (result.has(item.local_path)) throw new Error(`duplicate catalog local path: ${item.local_path}`);
    result.set(item.local_path, item.size_bytes);
  }
  return result;
}

function requireEntry(document: MappingDocument, path: string): MappingEntry {
  const entry = document.entries.find((item) => item.virtual_path === path);
  if (!entry) throw new Error(`mapping not found: ${path}`);
  return entry;
}

function sourceMetadata(entry: MappingEntry, size: number, hashes: Partial<Record<HashAlgorithm, string>> = {}): MappingEntry {
  const result: MappingEntry = { virtual_path: entry.virtual_path, local_path: entry.local_path, size_bytes: size };
  for (const algorithm of HASH_ALGORITHMS) {
    const value = hashes[algorithm];
    if (value) result[algorithm] = value;
  }
  return result;
}

function replaceEntry(document: MappingDocument, current: MappingEntry, replacement: MappingEntry): MappingEntry {
  document.entries[document.entries.indexOf(current)] = replacement;
  return replacement;
}

export function reconcileMapping(document: MappingDocument, catalog: LocalCatalog): MappingDocument {
  validateMapping(document);
  const sources = catalogMap(catalog);
  const next = copy(document);
  // Both temporary states are disposable discovery choices. A source that
  // disappears loses either entry and is discovered in inbox again if it returns.
  next.entries = next.entries.filter((entry) => !isTemporaryPath(entry.virtual_path) || sources.has(entry.local_path));
  const mappedLocal = new Set(next.entries.map((entry) => entry.local_path));
  const mappedVirtual = new Set(next.entries.map((entry) => entry.virtual_path));
  for (const [localPath, size] of sources) {
    if (mappedLocal.has(localPath)) continue;
    const virtualPath = `inbox/${localPath}`;
    if (mappedVirtual.has(virtualPath)) throw new Error(`virtual path collision: ${virtualPath}`);
    next.entries.push({ virtual_path: virtualPath, local_path: localPath, size_bytes: size });
    mappedLocal.add(localPath); mappedVirtual.add(virtualPath);
  }
  validateMapping(next);
  return next;
}

function extension(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function transitionTemporary(document: MappingDocument, catalog: LocalCatalog, paths: readonly string[], from: 'inbox' | 'ignore', to: 'inbox' | 'ignore'): MappingDocument {
  validateMapping(document); validateBatch(paths);
  const sizes = catalogMap(catalog); const next = copy(document);
  const selected = paths.map((path) => requireEntry(next, path));
  for (const entry of selected) {
    if (!(from === 'inbox' ? isInboxPath(entry.virtual_path) : isIgnoredPath(entry.virtual_path))) throw new Error(`only ${from} mappings may be changed`);
    const size = sizes.get(entry.local_path);
    if (size === undefined) {
      if (from === 'ignore' && to === 'inbox') {
        next.entries.splice(next.entries.indexOf(entry), 1);
        continue;
      }
      throw new Error('temporary source must be present');
    }
    const target = `${to}/${entry.local_path}`;
    if (next.entries.some((other) => other !== entry && other.virtual_path === target)) throw new Error(`virtual path collision: ${target}`);
    replaceEntry(next, entry, sourceMetadata({ ...entry, virtual_path: target }, size));
  }
  validateMapping(next); return next;
}

export const ignoreMappings = (document: MappingDocument, catalog: LocalCatalog, paths: readonly string[]) => transitionTemporary(document, catalog, paths, 'inbox', 'ignore');
export function unignoreMappings(document: MappingDocument, catalog: LocalCatalog, paths: readonly string[]): MappingDocument {
  validateMapping(document); validateBatch(paths);
  const existing = paths.filter((path) => document.entries.some((entry) => entry.virtual_path === path));
  // Reconciliation may already have removed an absent disposable ignore row.
  return existing.length ? transitionTemporary(document, catalog, existing, 'ignore', 'inbox') : copy(document);
}

function splitExtension(path: string): { stem: string; ext: string } {
  const ext = extension(path);
  return { stem: ext ? path.slice(0, -ext.length) : path, ext };
}

/**
 * Resolves flat managed-name collisions against the latest mapping snapshot.
 * Existing paths remain occupied for the whole operation, including paths that
 * another transition will release, so replacing a source never reuses a URL
 * that may still identify the old bytes in a browser cache.
 */
export function resolveMappingTransitions(document: MappingDocument, transitions: readonly MappingTransition[]): MappingTransition[] {
  validateMapping(document);
  const occupied = new Set(document.entries.map((entry) => entry.virtual_path));
  const resolved: MappingTransition[] = [];
  for (const transition of transitions) {
    const targetParts = transition.to ? splitExtension(transition.to) : null;
    const roleMatch = targetParts ? /^(.*)(a0|a1|b0|c0)$/.exec(targetParts.stem) : null;
    const attachmentNeedsTail = roleMatch?.[2] === 'c0' && [...occupied].some((path) => {
      const parts = splitExtension(path);
      return new RegExp(`^${roleMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}c[0-9]+$`, 'i').test(parts.stem);
    });
    if (transition.to === null || transition.to === transition.from || (!occupied.has(transition.to) && !attachmentNeedsTail)) {
      resolved.push(transition);
      if (transition.to) occupied.add(transition.to);
      continue;
    }
    const current = document.entries.find((entry) => entry.virtual_path === transition.from);
    const target = document.entries.find((entry) => entry.virtual_path === transition.to);
    if (current && target?.local_path === current.local_path) {
      resolved.push({ ...transition, to: transition.to });
      continue;
    }
    const { stem, ext } = targetParts!;
    const logoMatch = /^(.*-(?:horizontal-dark|horizontal|symbol))$/.exec(stem);
    let candidate: string | null = null;
    if (roleMatch) {
      const prefix = roleMatch[1], role = roleMatch[2];
      if (role === 'c0') {
        let maximum = -1;
        const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}c([0-9]+)$`, 'i');
        for (const path of occupied) {
          const matched = pattern.exec(splitExtension(path).stem);
          if (matched) maximum = Math.max(maximum, Number(matched[1]));
        }
        candidate = `${prefix}c${maximum + 1}${ext}`;
      } else {
        const family = role[0]; const start = Number(role[1]); const step = family === 'a' ? 2 : 1;
        for (let number = start; number < Number.MAX_SAFE_INTEGER; number += step) {
          const next = `${prefix}${family}${number}${ext}`;
          if (!occupied.has(next)) { candidate = next; break; }
        }
      }
    } else if (logoMatch) {
      for (let number = 1; number < Number.MAX_SAFE_INTEGER; number++) {
        const next = `${logoMatch[1]}-${number}${ext}`;
        if (!occupied.has(next)) { candidate = next; break; }
      }
    }
    if (!candidate) throw new Error(`virtual path collision: ${transition.to}`);
    occupied.add(candidate);
    resolved.push({ ...transition, to: candidate });
  }
  return resolved;
}

export function releaseMappings(document: MappingDocument, catalog: LocalCatalog, paths: readonly string[]): MappingDocument {
  validateMapping(document); validateBatch(paths);
  const sizes = catalogMap(catalog); const next = copy(document);
  for (const path of paths) {
    const entry = requireEntry(next, path);
    if (!isStablePath(entry.virtual_path)) throw new Error('only stable mappings may be released');
    const size = sizes.get(entry.local_path);
    if (size === undefined) {
      next.entries.splice(next.entries.indexOf(entry), 1);
      continue;
    }
    const target = `inbox/${entry.local_path}`;
    if (next.entries.some((other) => other !== entry && other.virtual_path === target)) throw new Error(`virtual path collision: ${target}`);
    replaceEntry(next, entry, sourceMetadata({ ...entry, virtual_path: target }, size));
  }
  validateMapping(next); return next;
}

/** Applies domain-coordinated renames/releases in one mapping document write. */
export function transitionMappings(document: MappingDocument, catalog: LocalCatalog, transitions: readonly MappingTransition[]): MappingDocument {
  validateMapping(document);
  if (!transitions.length || transitions.length > MAX_MAPPING_BATCH) throw new Error(`mapping transitions must contain 1 to ${MAX_MAPPING_BATCH} values`);
  validateBatch(transitions.map((item) => item.from), 'source paths');
  const targets = transitions.map((item) => item.to).filter((item): item is string => item !== null);
  if (new Set(targets).size !== targets.length) throw new Error('mapping transition targets must be unique');
  if (targets.some((path) => !isStablePath(path))) throw new Error('mapping transition targets must be stable paths');
  const sizes = catalogMap(catalog); const next = copy(document);
  const selected = transitions.map((transition) => ({ transition, entry: requireEntry(next, transition.from) }));
  const selectedPaths = new Set(selected.map(({ entry }) => entry.virtual_path));
  for (const { transition, entry } of selected) {
    if (!isStablePath(entry.virtual_path) && !(isInboxPath(entry.virtual_path) && transition.to !== null && sizes.has(entry.local_path))) {
      throw new Error('only stable mappings or present inbox first bindings may be coordinated');
    }
  }
  for (const { transition, entry } of selected) {
    const size = sizes.get(entry.local_path);
    if (transition.to === null && size === undefined) {
      next.entries.splice(next.entries.indexOf(entry), 1);
      continue;
    }
    const target = transition.to ?? `inbox/${entry.local_path}`;
    if (transition.to && extension(target) !== extension(entry.local_path)) throw new Error('mapping rename must preserve the source extension');
    if (next.entries.some((other) => other !== entry && other.virtual_path === target && !selectedPaths.has(other.virtual_path))) throw new Error(`virtual path collision: ${target}`);
    const replacement = transition.to
      ? { ...entry, virtual_path: target }
      : sourceMetadata({ ...entry, virtual_path: target }, size!);
    replaceEntry(next, entry, replacement);
  }
  validateMapping(next); return next;
}

export function rematchMappings(document: MappingDocument, catalog: LocalCatalog, selections: readonly RematchSelection[]): MappingDocument {
  validateMapping(document);
  if (!selections.length || selections.length > MAX_MAPPING_BATCH) throw new Error(`matches must contain 1 to ${MAX_MAPPING_BATCH} values`);
  validateBatch(selections.map((item) => item.targetVirtualPath), 'target paths');
  validateBatch(selections.map((item) => item.candidateVirtualPath), 'candidate paths');
  const sizes = catalogMap(catalog); const next = copy(document);
  for (const selection of selections) {
    const target = requireEntry(next, selection.targetVirtualPath);
    const candidate = requireEntry(next, selection.candidateVirtualPath);
    if (!isStablePath(target.virtual_path)) throw new Error('rematch target must be a stable mapping');
    if (!isInboxPath(candidate.virtual_path) || !sizes.has(candidate.local_path)) throw new Error('rematch candidate must be a present inbox mapping');
    const targetPath = target.virtual_path;
    const previousLocalPath = target.local_path;
    const previousSize = sizes.get(previousLocalPath);
    const releasedPath = `inbox/${previousLocalPath}`;
    if (previousSize !== undefined && next.entries.some((entry) => entry !== target && entry !== candidate && entry.virtual_path === releasedPath)) {
      throw new Error(`virtual path collision: ${releasedPath}`);
    }
    const replacement = sourceMetadata({ ...candidate, virtual_path: targetPath }, sizes.get(candidate.local_path)!, selection.hashes);
    next.entries[next.entries.indexOf(target)] = replacement;
    next.entries.splice(next.entries.indexOf(candidate), 1);
    if (previousSize !== undefined) next.entries.push({ virtual_path: releasedPath, local_path: previousLocalPath, size_bytes: previousSize });
  }
  validateMapping(next); return next;
}

function fieldValues(entry: MappingEntry, size: number | undefined, algorithms: readonly AutoMatchAlgorithm[], hashes: Partial<Record<HashAlgorithm, string | null>>): string[] | null {
  const values: string[] = [];
  for (const algorithm of algorithms) {
    const value = algorithm === 'filename' ? (entry.local_path.split('/').at(-1) ?? '').toLowerCase()
      : algorithm === 'sizeBytes' ? size
      : hashes[algorithm];
    if (value === undefined || value === null || value === '') return null;
    values.push(String(value));
  }
  return values;
}

export function autoMatchMappings(
  document: MappingDocument, catalog: LocalCatalog, targetPaths: readonly string[], candidatePaths: readonly string[],
  algorithms: readonly AutoMatchAlgorithm[], candidateHashes: Readonly<Record<string, Partial<Record<HashAlgorithm, string>>>>,
): { document: MappingDocument; applied: number; ambiguous: string[]; unmatched: string[] } {
  validateMapping(document); validateBatch(targetPaths, 'target paths'); validateBatch(candidatePaths, 'candidate paths');
  if (!algorithms.length || new Set(algorithms).size !== algorithms.length
    || algorithms.some((item) => item !== 'filename' && item !== 'sizeBytes' && !HASH_FIELDS.has(item))) throw new Error('invalid auto-match algorithms');
  const sizes = catalogMap(catalog);
  const targets = targetPaths.map((path) => requireEntry(document, path));
  const candidates = candidatePaths.map((path) => requireEntry(document, path));
  if (targets.some((entry) => !isStablePath(entry.virtual_path) || sizes.has(entry.local_path))) throw new Error('auto-match targets must be missing stable mappings');
  if (candidates.some((entry) => !isInboxPath(entry.virtual_path) || !sizes.has(entry.local_path))) throw new Error('auto-match candidates must be present inbox mappings');
  const candidateValues = new Map(candidates.map((entry) => [entry.virtual_path, fieldValues(entry, sizes.get(entry.local_path), algorithms, candidateHashes[entry.virtual_path] ?? {})]));
  const proposals = new Map<string, string[]>();
  for (const target of targets) {
    const expected = fieldValues(target, target.size_bytes ?? undefined, algorithms, target);
    proposals.set(target.virtual_path, expected === null ? [] : candidates.filter((candidate) => {
      const actual = candidateValues.get(candidate.virtual_path);
      return actual !== null && JSON.stringify(actual) === JSON.stringify(expected);
    }).map((candidate) => candidate.virtual_path));
  }
  const candidateCounts = new Map<string, number>();
  for (const options of proposals.values()) if (options.length === 1) candidateCounts.set(options[0], (candidateCounts.get(options[0]) ?? 0) + 1);
  const selections: RematchSelection[] = [];
  const ambiguous: string[] = []; const unmatched: string[] = [];
  for (const target of targets) {
    const options = proposals.get(target.virtual_path)!;
    if (options.length === 1 && candidateCounts.get(options[0]) === 1) {
      const hashes = candidateHashes[options[0]] ?? {};
      selections.push({ targetVirtualPath: target.virtual_path, candidateVirtualPath: options[0], hashes });
    } else if (options.length > 0) ambiguous.push(target.virtual_path);
    else unmatched.push(target.virtual_path);
  }
  return { document: selections.length ? rematchMappings(document, catalog, selections) : copy(document), applied: selections.length, ambiguous, unmatched };
}

export function applyFingerprints(document: MappingDocument, catalog: LocalCatalog, results: readonly VerifiedFingerprint[]): MappingDocument {
  validateMapping(document); const sources = catalogMap(catalog); const next = copy(document);
  for (const result of results) {
    const entry = next.entries.find((item) => item.virtual_path === result.virtualPath);
    if (!entry || !isStablePath(entry.virtual_path) || entry.local_path !== result.localPath || !sources.has(entry.local_path) || !result.value) continue;
    entry[result.algorithm] = result.value;
  }
  validateMapping(next); return next;
}

export function resourceInventory(document: MappingDocument, catalog: LocalCatalog): ResourceInventoryRow[] {
  validateMapping(document); const sources = catalogMap(catalog);
  return document.entries.map((entry): ResourceInventoryRow => {
    const present = sources.has(entry.local_path);
    const state: ResourceState = isIgnoredPath(entry.virtual_path) ? 'ignored' : isInboxPath(entry.virtual_path) ? 'pending' : !present ? 'missing' : 'mapped';
    return { virtualPath: entry.virtual_path, localPath: entry.local_path, state, present, sizeBytes: sources.get(entry.local_path) ?? entry.size_bytes ?? null, entry };
  });
}
