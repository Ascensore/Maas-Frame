import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary, withErrorBoundary } from '@/components/error-boundary';

function Boom({ message = 'render blew up' }: { message?: string }): never {
  throw new Error(message);
}

/**
 * Throws while the shared flag is set. React retries a failed render before it
 * gives up, so a counter would be consumed by the retry; a flag the test flips
 * explicitly keeps "Try again" deterministic.
 */
function ConditionalBoom({ shouldThrow }: { shouldThrow: { value: boolean } }) {
  if (shouldThrow.value) {
    throw new Error('transient');
  }
  return <p>Recovered content</p>;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React itself logs every caught error, on top of the boundary's own log.
  // Silence both; the assertions below check the boundary's log explicitly.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>Healthy content</p>
      </ErrorBoundary>
    );

    expect(screen.getByText('Healthy content')).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('replaces a crashed subtree with the recovery fallback', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
  });

  it('names the crashed area when given a context', () => {
    render(
      <ErrorBoundary context="Assets pane">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading', { name: 'Assets pane crashed' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'An unexpected error occurred. Try resetting the component or reload the page.'
      )
    ).toBeInTheDocument();
  });

  it('offers video-specific guidance for a video context', () => {
    render(
      <ErrorBoundary context="VideoPlayer">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading', { name: 'VideoPlayer crashed' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'The video player encountered an error. Try reloading or go back to the project.'
      )
    ).toBeInTheDocument();
  });

  it('does not swallow the error: it reports it to onError', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom message="player adapter missing" />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, errorInfo] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('player adapter missing');
    expect(errorInfo).toHaveProperty('componentStack');
    expect(String((errorInfo as { componentStack: string }).componentStack)).toContain('Boom');
  });

  it('does not swallow the error: it logs it with the context', () => {
    render(
      <ErrorBoundary context="VideoPlayer">
        <Boom message="player adapter missing" />
      </ErrorBoundary>
    );

    expect(consoleError).toHaveBeenCalledWith(
      'ErrorBoundary [VideoPlayer] caught an error:',
      expect.objectContaining({ message: 'player adapter missing' }),
      expect.anything()
    );
  });

  it('logs without a context prefix when none was given', () => {
    render(
      <ErrorBoundary>
        <Boom message="nameless" />
      </ErrorBoundary>
    );

    expect(consoleError).toHaveBeenCalledWith(
      'ErrorBoundary caught an error:',
      expect.objectContaining({ message: 'nameless' }),
      expect.anything()
    );
  });

  it('renders a custom fallback instead of the built-in one', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary fallback={<p>Could not load the timeline</p>} onError={onError}>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText('Could not load the timeline')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    // The error still propagates to the caller even with a custom fallback.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('re-renders the children when Try again is pressed', async () => {
    const shouldThrow = { value: true };
    render(
      <ErrorBoundary>
        <ConditionalBoom shouldThrow={shouldThrow} />
      </ErrorBoundary>
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.queryByText('Recovered content')).not.toBeInTheDocument();

    shouldThrow.value = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).not.toBeInTheDocument();
  });

  it('shows the fallback again if the retry crashes too', async () => {
    const shouldThrow = { value: true };
    render(
      <ErrorBoundary>
        <ConditionalBoom shouldThrow={shouldThrow} />
      </ErrorBoundary>
    );

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.queryByText('Recovered content')).not.toBeInTheDocument();
  });

  it('reloads the page when Reload page is pressed', async () => {
    const reload = vi.fn();
    // Restored by hand. vi.restoreAllMocks() undoes spies, not a
    // defineProperty, so without this the whole file runs on a fake
    // window.location from here on and the next test to touch it would be
    // reading a stub left behind by this one.
    const realLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    onTestFinished(() => {
      if (realLocation) {
        Object.defineProperty(window, 'location', realLocation);
      }
    });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reload page' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps a healthy sibling boundary mounted when one crashes', () => {
    render(
      <div>
        <ErrorBoundary context="Left">
          <Boom />
        </ErrorBoundary>
        <ErrorBoundary context="Right">
          <p>Right pane still here</p>
        </ErrorBoundary>
      </div>
    );

    expect(screen.getByRole('heading', { name: 'Left crashed' })).toBeInTheDocument();
    expect(screen.getByText('Right pane still here')).toBeInTheDocument();
  });

  it('catches an error thrown from a state updater, not just from render', async () => {
    function ThrowOnClick() {
      const [, setState] = useState(0);
      return (
        <button
          type="button"
          onClick={() => {
            setState(() => {
              throw new Error('from updater');
            });
          }}
        >
          Break it
        </button>
      );
    }

    render(
      <ErrorBoundary>
        <ThrowOnClick />
      </ErrorBoundary>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Break it' }));

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Break it' })).not.toBeInTheDocument();
  });
});

describe('withErrorBoundary', () => {
  it('wraps a component and forwards its props', () => {
    function Panel({ label }: { label: string }) {
      return <p>{label}</p>;
    }
    const Wrapped = withErrorBoundary(Panel);

    render(<Wrapped label="Timeline" />);

    expect(screen.getByText('Timeline')).toBeInTheDocument();
  });

  it('applies the boundary options to a crash inside the wrapped component', () => {
    const onError = vi.fn();
    const Wrapped = withErrorBoundary(Boom, { context: 'VideoPlayer', onError });

    render(<Wrapped />);

    expect(screen.getByRole('heading', { name: 'VideoPlayer crashed' })).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
