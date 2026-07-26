import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuestGate } from '@/components/guest-gate';

// next/link needs the App Router context to mount. The sign-in link is
// incidental to the validation branches under test, so stub it to an anchor.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const STORAGE_KEY = 'openframe_guest_name';

function renderGate() {
  return render(
    <GuestGate>
      <p>Gated video page</p>
    </GuestGate>
  );
}

/**
 * ACCESSIBILITY FINDING: the name field has no <label> and no aria-label, so it
 * has no accessible name. `getByRole('textbox')` finds it only because it is the
 * one textbox on the page. Reported, not worked around.
 */
function nameField() {
  return screen.getByRole('textbox');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('GuestGate', () => {
  it('hides the content behind a name prompt for a first-time visitor', () => {
    renderGate();

    expect(screen.getByRole('heading', { name: 'Welcome to OpenFrame' })).toBeInTheDocument();
    expect(screen.queryByText('Gated video page')).not.toBeInTheDocument();
    expect(nameField()).toHaveValue('');
  });

  it('skips the prompt for a visitor who already gave a name', () => {
    localStorage.setItem(STORAGE_KEY, 'Kerem');

    renderGate();

    expect(screen.getByText('Gated video page')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome to OpenFrame' })).not.toBeInTheDocument();
  });

  it('still prompts when the stored name is an empty string', () => {
    localStorage.setItem(STORAGE_KEY, '');

    renderGate();

    expect(screen.getByRole('heading', { name: 'Welcome to OpenFrame' })).toBeInTheDocument();
    expect(screen.queryByText('Gated video page')).not.toBeInTheDocument();
  });

  it('keeps Continue disabled until a real name is typed', async () => {
    renderGate();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await userEvent.type(nameField(), '   ');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await userEvent.type(nameField(), 'K');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('reveals the content and remembers the name on Continue', async () => {
    renderGate();

    await userEvent.type(nameField(), 'Kerem');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText('Gated video page')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('Kerem');
  });

  it('confirms on Enter as well as on the button', async () => {
    renderGate();

    await userEvent.type(nameField(), 'Kerem{Enter}');

    expect(screen.getByText('Gated video page')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('Kerem');
  });

  it('stores the trimmed name', async () => {
    renderGate();

    await userEvent.type(nameField(), '  Kerem  {Enter}');

    expect(localStorage.getItem(STORAGE_KEY)).toBe('Kerem');
  });

  it('does not confirm on Enter with a whitespace-only name', async () => {
    renderGate();

    await userEvent.type(nameField(), '   {Enter}');

    expect(screen.queryByText('Gated video page')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('caps the name at 100 characters in the field itself', async () => {
    renderGate();

    expect(nameField()).toHaveAttribute('maxLength', '100');
    await userEvent.type(nameField(), 'x'.repeat(140));

    // The `trimmed.length > 100` guard in the component is therefore
    // unreachable through the UI: the field can never hold a longer value.
    expect(nameField()).toHaveValue('x'.repeat(100));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('offers a sign-in escape hatch instead of the gate', () => {
    renderGate();

    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/login');
  });
});
