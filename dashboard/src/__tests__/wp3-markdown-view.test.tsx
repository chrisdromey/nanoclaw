/**
 * WP3 — MarkdownView renders GFM (tables!) with the dark-theme component map.
 * KB documents rely on GFM tables, so <table> must be a real table element.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import MarkdownView from '../components/shared/MarkdownView';

const GFM_FIXTURE = `# Kia EV6 spec sheet

Some **bold** intro text with \`inline code\`.

| Trim | Battery | Heat pump |
| ---- | ------- | --------- |
| Air | 77.4 kWh | Optional |
| GT-Line S | 77.4 kWh | Standard |

- First bullet
- Second bullet

[Kia UK source](https://www.kia.com/uk/ev6/)
`;

describe('MarkdownView', () => {
  it('renders headings', () => {
    render(<MarkdownView markdown={GFM_FIXTURE} />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Kia EV6 spec sheet');
  });

  it('renders GFM tables as real <table> elements with cells', () => {
    const { container } = render(<MarkdownView markdown={GFM_FIXTURE} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(screen.getByRole('table')).toBeInTheDocument();
    // Header cells
    expect(screen.getByRole('columnheader', { name: 'Trim' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Heat pump' })).toBeInTheDocument();
    // Body cells
    expect(screen.getByRole('cell', { name: 'GT-Line S' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Optional' })).toBeInTheDocument();
  });

  it('renders external links with target=_blank and rel=noopener noreferrer', () => {
    render(<MarkdownView markdown={GFM_FIXTURE} />);
    const link = screen.getByRole('link', { name: 'Kia UK source' });
    expect(link).toHaveAttribute('href', 'https://www.kia.com/uk/ev6/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders inline code and strong text', () => {
    const { container } = render(<MarkdownView markdown={GFM_FIXTURE} />);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('inline code');
    const strong = container.querySelector('strong');
    expect(strong).toHaveTextContent('bold');
  });

  it('renders lists', () => {
    render(<MarkdownView markdown={GFM_FIXTURE} />);
    expect(screen.getByText('First bullet')).toBeInTheDocument();
    expect(screen.getByText('Second bullet')).toBeInTheDocument();
  });

  it('does not use dangerouslySetInnerHTML (raw HTML is not injected)', () => {
    const { container } = render(
      <MarkdownView markdown={'hello <img src=x onerror="window.__pwned=1"> world'} />,
    );
    expect(container.querySelector('img')).toBeNull();
  });
});
