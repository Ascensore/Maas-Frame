import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Linkify } from '@/components/linkify';

describe('Linkify', () => {
  it('renders a bare http(s) URL as a new-tab link', () => {
    render(<Linkify>{'Ticket at https://tracker.test/OF-12 please'}</Linkify>);

    const link = screen.getByRole('link', { name: 'https://tracker.test/OF-12' });
    expect(link).toHaveAttribute('href', 'https://tracker.test/OF-12');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps the surrounding text intact', () => {
    const { container } = render(
      <Linkify>{'Ticket at https://tracker.test/OF-12 please'}</Linkify>
    );

    expect(container).toHaveTextContent('Ticket at https://tracker.test/OF-12 please');
  });

  it('links every URL in the string', () => {
    render(<Linkify>{'http://a.test/1 then https://b.test/2'}</Linkify>);

    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      'http://a.test/1',
      'https://b.test/2',
    ]);
  });

  it('leaves plain text alone', () => {
    render(<Linkify>{'No links in this sentence'}</Linkify>);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('No links in this sentence')).toBeInTheDocument();
  });

  it('passes non-string children straight through', () => {
    render(
      <Linkify>
        <span data-testid="child">https://not-parsed.test/x</span>
      </Linkify>
    );

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByTestId('child')).toHaveTextContent('https://not-parsed.test/x');
  });

  it('does not turn a javascript: URL into a link', () => {
    const { container } = render(<Linkify>{'javascript:alert(document.cookie)'}</Linkify>);

    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('javascript:alert(document.cookie)');
  });

  it('does not turn a data: URL into a link', () => {
    const { container } = render(
      <Linkify>{'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='}</Linkify>
    );

    expect(container.querySelector('a')).toBeNull();
  });

  it('does not link vbscript:, file: or protocol-relative URLs', () => {
    const { container } = render(
      <Linkify>{'vbscript:msgbox(1) file:///etc/passwd //evil.test/x'}</Linkify>
    );

    expect(container.querySelector('a')).toBeNull();
  });

  it('never injects markup from the string', () => {
    const { container } = render(<Linkify>{'<img src=x onerror="alert(1)">'}</Linkify>);

    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
  });

  it('is case sensitive about the scheme, matching CommentRichText', () => {
    const { container } = render(<Linkify>{'HTTPS://EXAMPLE.COM/a'}</Linkify>);

    expect(container.querySelector('a')).toBeNull();
  });

  it('swallows trailing punctuation into the href, matching CommentRichText', () => {
    render(<Linkify>{'Fixed in https://example.com/pr/12.'}</Linkify>);

    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/pr/12.');
  });

  it('does not let a click on the link reach an enclosing handler', async () => {
    const onRowClick = vi.fn();
    render(
      // Mirrors the real call sites, where Linkify sits inside a clickable
      // comment row.
      <div onClick={onRowClick}>
        <Linkify>{'https://tracker.test/OF-12'}</Linkify>
      </div>
    );

    const link = screen.getByRole('link');
    link.addEventListener('click', (event) => event.preventDefault());
    await userEvent.click(link);

    expect(onRowClick).not.toHaveBeenCalled();
  });
});
