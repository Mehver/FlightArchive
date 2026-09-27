// SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
// SPDX-License-Identifier: BSD-3-Clause

const IMAGE_EXTENSIONS = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;

export function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export function parentFolder(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

export function middleEllipsisPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 1) return basename(path);
  return `${segments[0]}/…/${basename(path)}`;
}

export function fileKind(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toUpperCase();
}

export function isImageResource(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}

export function isPendingInbox(path: string): boolean {
  return path.startsWith('inbox/');
}
