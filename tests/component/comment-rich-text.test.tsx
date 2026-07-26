import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentRichText } from '@/components/video-page/comment-rich-text';
import type { VideoAsset } from '@/components/video-page/types';

function makeAsset(overrides: Partial<VideoAsset> = {}): VideoAsset {
  return {
    id: 'a1b2c3',
    videoId: 'vid1',
    kind: 'IMAGE',
    provider: 'R2_IMAGE',
    displayName: 'Reference frame.png',
    sourceUrl: null,
    providerVideoId: null,
    thumbnailUrl: null,
    uploadedByUserId: 'user1',
    uploadedByGuestName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    uploadedByUser: null,
    canDelete: true,
    ...overrides,
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Mentions mixed with text make React complain about duplicate keys (see the
  // pinned bug at the bottom of this file). Silence it so the suite output stays
  // readable; that one test asserts the warning is still there.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CommentRichText linkification', () => {
  it('renders a bare http(s) URL as a new-tab link', () => {
    render(<CommentRichText text="See https://example.com/shot-3 for the grade" />);

    const link = screen.getByRole('link', { name: 'https://example.com/shot-3' });
    expect(link).toHaveAttribute('href', 'https://example.com/shot-3');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps the surrounding text intact', () => {
    const { container } = render(
      <CommentRichText text="See https://example.com/shot-3 for the grade" />
    );

    expect(container).toHaveTextContent('See https://example.com/shot-3 for the grade');
  });

  it('links every URL in the comment', () => {
    render(<CommentRichText text="http://a.test/1 and https://b.test/2 and https://c.test/3" />);

    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      'http://a.test/1',
      'https://b.test/2',
      'https://c.test/3',
    ]);
  });

  it('renders text with no URL as plain text', () => {
    render(<CommentRichText text="Just a note about the cut" />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('Just a note about the cut')).toBeInTheDocument();
  });

  it('renders nothing for an empty comment', () => {
    const { container } = render(<CommentRichText text="" />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('CommentRichText URL scheme safety', () => {
  it('does not turn a javascript: URL into a link', () => {
    const { container } = render(<CommentRichText text="javascript:alert(document.cookie)" />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('javascript:alert(document.cookie)');
  });

  it('does not turn a javascript: URL into a link mid-sentence either', () => {
    const { container } = render(
      <CommentRichText text="click javascript:alert(1) now, or JavaScript:alert(1)" />
    );

    expect(container.querySelector('a')).toBeNull();
  });

  it('does not turn a data: URL into a link', () => {
    const { container } = render(
      <CommentRichText text="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" />
    );

    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('data:text/html;base64');
  });

  it('does not link vbscript:, file: or protocol-relative URLs', () => {
    const { container } = render(
      <CommentRichText text="vbscript:msgbox(1) file:///etc/passwd //evil.test/x" />
    );

    expect(container.querySelector('a')).toBeNull();
  });

  it('never injects markup from the comment body', () => {
    const { container } = render(
      <CommentRichText text={'<img src=x onerror="alert(1)"> <script>alert(2)</script>'} />
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
  });

  it('is case sensitive about the scheme, so HTTPS:// is left as text', () => {
    // Pinning current behaviour: the regex has no `i` flag, so an uppercase
    // scheme is not linkified. Harmless, but worth knowing before someone
    // "fixes" the regex and widens what becomes clickable.
    const { container } = render(<CommentRichText text="HTTPS://EXAMPLE.COM/a" />);

    expect(container.querySelector('a')).toBeNull();
  });

  it('swallows trailing punctuation into the href', () => {
    // Pinning current behaviour: `[^\s]+` is greedy to the next whitespace, so
    // the sentence-ending period lands inside the link.
    render(<CommentRichText text="Fixed in https://example.com/pr/12." />);

    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/pr/12.');
  });
});

describe('CommentRichText asset mentions', () => {
  it('renders a mention as a button labelled with the asset name', () => {
    render(<CommentRichText text="Compare with @[Reference frame.png](asset:a1b2c3)" />);

    expect(screen.getByRole('button', { name: '@Reference frame.png' })).toBeInTheDocument();
  });

  it('reports the mentioned asset id when clicked', async () => {
    const onAssetMentionClick = vi.fn();
    render(
      <CommentRichText
        text="Compare with @[Reference frame.png](asset:a1b2c3)"
        onAssetMentionClick={onAssetMentionClick}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: '@Reference frame.png' }));

    expect(onAssetMentionClick).toHaveBeenCalledWith('a1b2c3');
  });

  it('prefers the current asset name over the name stored in the comment', () => {
    render(
      <CommentRichText
        text="Compare with @[old-name.png](asset:a1b2c3)"
        assets={[makeAsset({ displayName: 'Renamed.png' })]}
      />
    );

    expect(screen.getByRole('button', { name: '@Renamed.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '@old-name.png' })).not.toBeInTheDocument();
  });

  it('falls back to the stored name when the asset is gone', () => {
    render(<CommentRichText text="@[deleted.png](asset:zzz999)" assets={[makeAsset()]} />);

    expect(screen.getByRole('button', { name: '@deleted.png' })).toBeInTheDocument();
  });

  it('does not throw when clicked without a handler', async () => {
    render(<CommentRichText text="@[Reference frame.png](asset:a1b2c3)" />);

    await userEvent.click(screen.getByRole('button', { name: '@Reference frame.png' }));

    expect(screen.getByRole('button', { name: '@Reference frame.png' })).toBeInTheDocument();
  });

  it('renders text, mentions and links together in reading order', () => {
    const { container } = render(
      <CommentRichText text="Before @[One](asset:aaa111) middle https://example.com/x after" />
    );

    expect(container).toHaveTextContent('Before @One middle https://example.com/x after');
    expect(screen.getByRole('button', { name: '@One' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.com/x' })).toBeInTheDocument();
  });

  it('renders several mentions in one comment', () => {
    render(<CommentRichText text="@[One](asset:aaa111) then @[Two](asset:bbb222)" />);

    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['@One', '@Two']);
  });

  it('accepts an uppercase asset id', () => {
    const onAssetMentionClick = vi.fn();
    render(
      <CommentRichText text="@[One](asset:AAA111)" onAssetMentionClick={onAssetMentionClick} />
    );

    expect(screen.getByRole('button', { name: '@One' })).toBeInTheDocument();
  });

  it('leaves a mention with a non-alphanumeric id as plain text', () => {
    const { container } = render(<CommentRichText text="@[One](asset:aa-11)" />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container).toHaveTextContent('@[One](asset:aa-11)');
  });

  it('leaves a malformed mention as plain text', () => {
    const { container } = render(<CommentRichText text="@[One](assets:aaa111) @[Two] (asset:b)" />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container).toHaveTextContent('@[One](assets:aaa111)');
  });

  it('does not inject markup through the mention label', () => {
    const { container } = render(
      <CommentRichText text={'@[<img src=x onerror="alert(1)">](asset:aaa111)'} />
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('@<img src=x onerror="alert(1)">');
  });

  it('does not linkify a URL used as a mention label', () => {
    const { container } = render(<CommentRichText text="@[https://evil.test/x](asset:aaa111)" />);

    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByRole('button', { name: '@https://evil.test/x' })).toBeInTheDocument();
  });

  // `renderUrls` used to key its fragments by the index within its own slice, and
  // CommentRichText calls it once per gap between mentions, so the same key ("txt-0") was
  // emitted for several siblings and React warned that children may be duplicated or
  // omitted. The keys carry the slice offset now.
  it('emits no duplicate React keys when text surrounds a mention', () => {
    const { container } = render(
      <CommentRichText text="Before @[One](asset:aaa111) middle @[Two](asset:bbb222) after" />
    );

    expect(container).toHaveTextContent('Before @One middle @Two after');
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('same key'),
      expect.anything()
    );
  });
});
