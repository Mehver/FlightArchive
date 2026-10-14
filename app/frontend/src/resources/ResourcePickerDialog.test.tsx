// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n';
import { fakeRfgClient, ResourceTestWrapper } from '../rfg/testFixtures';
import { ResourcePickerDialog } from './ResourcePickerDialog';

afterEach(cleanup);

describe('ResourcePickerDialog', () => {
  it('registers a newly scanned file and exposes its confirmed inbox entry', async () => {
    const client = fakeRfgClient({ entries: [] }, { local_files: [{ local_path: 'candidate.png', size_bytes: 2 }] });
    const put = vi.spyOn(client, 'putMapping');
    render(<LanguageProvider><ResourceTestWrapper client={client}><ResourcePickerDialog open title="Inbox" selected={[]} selectable="inbox" onConfirm={vi.fn()} onClose={vi.fn()} /></ResourceTestWrapper></LanguageProvider>);
    await waitFor(() => expect(screen.getByText('inbox/candidate.png')).toBeTruthy());
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('defaults to bindable stable and inbox resources, retains a selected missing stable path, and has no Ignore action', async () => {
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
    expect(screen.getByText('inbox/new.png')).toBeTruthy();
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
