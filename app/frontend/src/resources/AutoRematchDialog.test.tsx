// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n';
import { fakeRfgClient, ResourceTestWrapper } from '../rfg/testFixtures';
import { AutoRematchDialog } from './AutoRematchDialog';

it('shows only present inbox candidates for automatic rematch', async () => {
  const client = fakeRfgClient({ entries: [
    { virtual_path: 'inbox/new.png', local_path: 'new.png' },
    { virtual_path: 'objects/stable.png', local_path: 'stable.png' },
  ] }, { local_files: [{ local_path: 'new.png', size_bytes: 1 }, { local_path: 'stable.png', size_bytes: 1 }] });
  render(<LanguageProvider><ResourceTestWrapper client={client}><AutoRematchDialog open targetPaths={['objects/lost.png']} busy={false} onApply={vi.fn()} onClose={vi.fn()} /></ResourceTestWrapper></LanguageProvider>);
  await waitFor(() => expect(screen.getByText('inbox/new.png')).toBeTruthy());
  expect(screen.queryByText('objects/stable.png')).toBeNull();
});
