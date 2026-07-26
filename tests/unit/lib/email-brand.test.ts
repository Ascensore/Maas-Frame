import { describe, expect, it } from 'vitest';
import {
  EMAIL_COLORS,
  brandedEmailTemplate,
  emailButton,
  emailHeading,
  emailHighlight,
  emailRow,
  escapeAttr,
  escapeHtml,
  rawEmailHtml,
} from '@/lib/email-brand';

describe('escapeHtml', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
  ])('escapes %s as %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('neutralises a script tag', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes the ampersand first so an existing entity is not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  // Single-quoted attributes exist in the templates, so leaving the quote alone left a
  // value able to close one.
  it('escapes the single quote', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('Alice reviewed your video')).toBe('Alice reviewed your video');
  });

  it('returns an empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('escapeAttr', () => {
  it('escapes the same four characters as escapeHtml', () => {
    expect(escapeAttr('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });

  it('breaks an attribute injection attempt', () => {
    const escaped = escapeAttr('https://x.com" onmouseover="alert(1)');

    expect(escaped).not.toContain('" onmouseover');
    expect(escaped).toContain('&quot; onmouseover=&quot;');
  });

  it('agrees with escapeHtml on every input despite the different replacement order', () => {
    for (const input of ['&', '<', '>', '"', '&lt;', 'a&b<c>d"e']) {
      expect(escapeAttr(input)).toBe(escapeHtml(input));
    }
  });
});

describe('brandedEmailTemplate', () => {
  it('produces a full HTML document carrying the brand colours', () => {
    const html = brandedEmailTemplate('<td>Body</td>');

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain(EMAIL_COLORS.bg);
    expect(html).toContain('OpenFrame');
  });

  it('inserts the body markup verbatim', () => {
    expect(brandedEmailTemplate('<td>Hello &amp; welcome</td>')).toContain(
      '<td>Hello &amp; welcome</td>'
    );
  });

  it('omits the footer block when no footer options are given', () => {
    expect(brandedEmailTemplate('<td>Body</td>')).not.toContain(
      'padding:20px 0 0;text-align:center'
    );
  });

  it('renders footer text on its own', () => {
    const html = brandedEmailTemplate('<td>Body</td>', { footerText: 'Sent by OpenFrame' });

    expect(html).toContain('Sent by OpenFrame');
    expect(html).not.toContain('<a href=');
  });

  it('renders the footer link only when both the text and the url are present', () => {
    const withTextOnly = brandedEmailTemplate('<td>Body</td>', { footerLinkText: 'Unsubscribe' });
    const withBoth = brandedEmailTemplate('<td>Body</td>', {
      footerLinkText: 'Unsubscribe',
      footerLinkUrl: 'https://open-frame.net/settings',
    });

    expect(withTextOnly).not.toContain('Unsubscribe');
    expect(withBoth).toContain('href="https://open-frame.net/settings"');
    expect(withBoth).toContain('>Unsubscribe<');
  });

  it('escapes the footer link url as an attribute', () => {
    const html = brandedEmailTemplate('<td>Body</td>', {
      footerLinkText: 'Unsubscribe',
      footerLinkUrl: 'https://x.com" onmouseover="alert(1)',
    });

    expect(html).not.toContain('" onmouseover="alert(1)"');
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)');
  });

  it('escapes the footer link text as HTML', () => {
    const html = brandedEmailTemplate('<td>Body</td>', {
      footerLinkText: '<script>alert(1)</script>',
      footerLinkUrl: 'https://open-frame.net',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('email fragment builders', () => {
  it('emailHeading renders the icon and title in the accent colour', () => {
    const html = emailHeading('🎬', 'New comment');

    expect(html).toContain('🎬');
    expect(html).toContain('New comment');
    expect(html).toContain(EMAIL_COLORS.accent);
  });

  it('emailRow renders the label and value in a table row', () => {
    const html = emailRow('Project', 'Launch video');

    expect(html.startsWith('<tr>')).toBe(true);
    expect(html).toContain('Project');
    expect(html).toContain('Launch video');
  });

  it('emailRow switches to the highlight style when asked', () => {
    const plain = emailRow('Project', 'Launch video');
    const highlighted = emailRow('Project', 'Launch video', true);

    expect(plain).toContain(EMAIL_COLORS.textSecondary);
    expect(highlighted).toContain('font-weight:600');
    expect(highlighted).not.toContain(EMAIL_COLORS.textSecondary);
  });

  it('emailButton escapes both the href and the label', () => {
    const html = emailButton('<b>Open</b>', 'https://x.com" onclick="alert(1)');

    expect(html).toContain('&quot; onclick=&quot;alert(1)');
    expect(html).toContain('&lt;b&gt;Open&lt;/b&gt;');
    expect(html).not.toContain('<b>Open</b>');
  });

  // The escaping lives in the helpers rather than in every call site, so a project name
  // or a display name is safe whether or not the next caller remembers to escape it.
  it.each([
    ['emailHeading title', () => emailHeading('*', '<script>alert(1)</script>')],
    ['emailRow label', () => emailRow('<script>alert(1)</script>', 'value')],
    ['emailRow value', () => emailRow('label', '<script>alert(1)</script>')],
    ['emailHighlight text', () => emailHighlight('<script>alert(1)</script>')],
    ['emailButton label', () => emailButton('<script>alert(1)</script>', 'https://x.test')],
  ])('%s is escaped', (_label, build) => {
    const html = build();

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('rawEmailHtml opts a value out of escaping', () => {
    const html = emailRow('From', rawEmailHtml('<span>Alice</span>'));

    expect(html).toContain('<span>Alice</span>');
  });

  it('escapes the footer text', () => {
    const html = brandedEmailTemplate('<tr><td>body</td></tr>', {
      footerText: '<script>alert(1)</script>',
    });

    expect(html).not.toContain('<script>');
  });

  it('inserts the body markup verbatim', () => {
    const html = brandedEmailTemplate('<tr><td>body</td></tr>');

    expect(html).toContain('<tr><td>body</td></tr>');
  });

  it('emailHighlight wraps the text in a bordered block', () => {
    const html = emailHighlight('Your trial ends in 2 days');

    expect(html.startsWith('<div')).toBe(true);
    expect(html).toContain('Your trial ends in 2 days');
    expect(html).toContain(EMAIL_COLORS.cardInner);
  });

  it('every brand colour is a six digit hex value', () => {
    for (const value of Object.values(EMAIL_COLORS)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
