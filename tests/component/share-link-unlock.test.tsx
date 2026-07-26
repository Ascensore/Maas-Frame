import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareLinkUnlock } from '@/components/share-link-unlock';

const replace = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

// next/link needs the App Router context to mount. The link is incidental to
// the validation branches under test, so stub it down to an anchor.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * A password input has no ARIA role, so `getByRole` cannot reach it whatever the
 * markup does. `getByLabelText` can, and it only works because the field now has a
 * visually hidden <label> associated by id: it used to have no label, no aria-label and
 * no aria-labelledby, which left the placeholder as the only handle anything had.
 */
function passwordField() {
  return screen.getByLabelText('Password');
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  replace.mockReset();
  refresh.mockReset();
});

describe('ShareLinkUnlock', () => {
  it('asks for the password and offers a sign-in escape hatch', () => {
    render(<ShareLinkUnlock videoId="vid1" />);

    expect(screen.getByRole('heading', { name: 'Password Required' })).toBeInTheDocument();
    expect(passwordField()).toHaveAttribute('type', 'password');
    expect(passwordField()).toHaveAttribute('maxLength', '128');
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/login');
  });

  it('ignores a submit with an empty field', async () => {
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('ignores a submit with only whitespace', async () => {
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), '    ');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the password to the session endpoint for this video', async () => {
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/watch/vid1/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ password: 'hunter2' });
  });

  it('sends the password verbatim, without trimming', async () => {
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), ' hunter2 ');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      password: ' hunter2 ',
    });
  });

  it('navigates into the video on success', async () => {
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/watch/vid1'));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Invalid password')).not.toBeInTheDocument();
  });

  it('submits on Enter as well as on the button', async () => {
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), 'hunter2{Enter}');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith('/watch/vid1');
  });

  it('shows the server message for a rejected password', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'This link has expired' }),
    });
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('falls back to "Invalid password" when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.reject(new SyntaxError('nope')) });
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Invalid password')).toBeInTheDocument();
  });

  it('reports a network failure separately from a wrong password', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Failed to verify password')).toBeInTheDocument();
  });

  it('clears a stale error when the password is retried', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'This link has expired' }),
    });
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();

    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/watch/vid1'));
    expect(screen.queryByText('This link has expired')).not.toBeInTheDocument();
  });

  it('blocks a second submit while the first is still in flight', async () => {
    let release: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    render(<ShareLinkUnlock videoId="vid1" />);

    await userEvent.type(passwordField(), 'hunter2');
    const submit = screen.getByRole('button', { name: 'Continue' });
    await userEvent.click(submit);

    expect(submit).toBeDisabled();
    // The spinner that replaces the label carries a visually hidden name, so the button
    // stays findable and announceable while it submits.
    expect(submit).toHaveAccessibleName('Unlocking');

    release({ ok: true, json: () => Promise.resolve({}) });
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
