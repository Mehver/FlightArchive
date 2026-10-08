// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n';
import { fakeRfgClient, ResourceTestWrapper } from '../rfg/testFixtures';
import { ResourcePickerDialog } from './ResourcePickerDialog';

describe('ResourcePickerDialog', () => {
  it('defaults to stable resources, retains a selected missing stable path, and has no Ignore action', async () => {
    const client = fakeRfgClient({ entries: [
      { virtual_path: 'objects/live.png', local_path: 'live.png' },
      { virtual_path: 'objects/missing.png', local_path: 'gone.png' },
      { virtual_path: 'inbox/new.png', local_path: 'new.png' },
    ] }, { local_files: [{ local_path: 'live.png', size_bytes: 1 }, { local_path: 'new.png', size_bytes: 1 }] });
    const onConfirm = vi.fn();
    const put = vi.spyOn(client, 'putMapping');
    render(<LanguageProvider><ResourceTestWrapper client={client}><ResourcePickerDialog open title="Attachments" selected={['objects/missing.png']} onConfirm={onConfirm} onClose={vi.fn()} /></ResourceTestWrapper></LanguageProvider>);
    await waitFor(() => expect(screen.getByText('objects/live.png')).toBeTruthy());
    expect(screen.getByRole('dialog', { name: 'Attachments' })).toBeTruthy();
    expect(screen.getByText('objects/missing.png')).toBeTruthy();
    expect(screen.queryByText('inbox/new.png')).toBeNull();
    expect(screen.queryByRole('button', { name: /ignore/i })).toBeNull();
    expect(screen.queryByAltText('missing.png')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'List View' }));
    expect(screen.getByRole('table', { name: 'Attachments' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /missing\.png/i }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Select Resource' }));
    expect(onConfirm).toHaveBeenCalledWith(['objects/missing.png']);
    expect(put).not.toHaveBeenCalled();
  });
});
