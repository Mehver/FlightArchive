// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../i18n';
import { fakeRfgClient, ResourceTestWrapper } from '../rfg/testFixtures';
import { ResourceBrowser } from './ResourceBrowser';
import { useResourceBrowser } from './useResourceBrowser';

function Harness() {
  const browser = useResourceBrowser({ active: true });
  return <ResourceBrowser browser={browser} label="Resources" />;
}

describe('ResourceBrowser', () => {
  it('freshly reads and shows stable resources without usage metadata', async () => {
    const client = fakeRfgClient({ entries: [{ virtual_path: 'objects/a.pdf', local_path: 'a.pdf' }] }, { local_files: [{ local_path: 'a.pdf', size_bytes: 2 }] });
    render(<LanguageProvider><ResourceTestWrapper client={client}><Harness /></ResourceTestWrapper></LanguageProvider>);
    await waitFor(() => expect(screen.getByText('objects/a.pdf')).toBeTruthy());
    expect(screen.queryByText(/flight/i)).toBeNull();
  });
});
