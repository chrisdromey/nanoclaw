/**
 * WP2: TargetsStrip — model chips link to encoded Spec Explorer URLs with a
 * KB/verification status dot and citation count per chip.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

import TargetsStrip from '../components/verticals/cars/TargetsStrip';
import type { TargetInfo, TargetVerification } from '@shared/types';

function verification(
  verdict: TargetVerification['verdict'],
  feature = 'Adaptive cruise control',
): TargetVerification {
  return {
    feature,
    verdict,
    evidence_url: null,
    notes: null,
    checked_at: '2026-07-01T00:00:00',
  };
}

function target(
  key: string,
  kb: TargetInfo['kb'],
  verifications: TargetVerification[],
): TargetInfo {
  return { target_key: key, criteria: {}, kb, verifications };
}

const kb = (citations: number): TargetInfo['kb'] => ({
  kb_path: `references/hunts/kb/${citations}.md`,
  citation_count: citations,
  must_have_citations: {},
  built_at: '2026-06-30T00:00:00',
});

const targets: TargetInfo[] = [
  target('Kia EV6', kb(6), [verification('verified'), verification('verified', 'Heat pump')]),
  target('Hyundai Ioniq 5', kb(4), [verification('verified'), verification('contradicted', 'Heat pump')]),
  target('VW ID.4', kb(0), [verification('verified'), verification('unverified', 'Heat pump')]),
  target('Skoda Enyaq', null, []),
];

function renderStrip(list: TargetInfo[] = targets, huntId = 11) {
  return render(
    <MemoryRouter>
      <TargetsStrip huntId={huntId} targets={list} />
    </MemoryRouter>,
  );
}

describe('TargetsStrip — links', () => {
  it('renders the "Models:" label and one chip per target', () => {
    renderStrip();
    expect(screen.getByText('Models:')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('links each chip to the URL-encoded Spec Explorer route', () => {
    renderStrip();
    const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/hunts/11/models/Kia%20EV6');
    expect(hrefs).toContain('/hunts/11/models/Hyundai%20Ioniq%205');
    expect(hrefs).toContain('/hunts/11/models/VW%20ID.4');
    expect(hrefs).toContain('/hunts/11/models/Skoda%20Enyaq');
  });

  it('shows the citation count only when a KB with citations exists', () => {
    renderStrip();
    expect(screen.getByText('· 6 cites')).toBeInTheDocument();
    expect(screen.getByText('· 4 cites')).toBeInTheDocument();
    // VW ID.4 has a KB with 0 citations; Skoda Enyaq has no KB
    expect(screen.queryByText('· 0 cites')).not.toBeInTheDocument();
    expect(screen.getAllByText(/cites/)).toHaveLength(2);
  });
});

describe('TargetsStrip — status dots', () => {
  it('shows a success dot when all verifications are verified', () => {
    renderStrip();
    const dot = screen.getByTitle('All claims independently verified');
    expect(dot.className).toContain('bg-success');
    expect(dot.closest('a')).toHaveAttribute('href', '/hunts/11/models/Kia%20EV6');
  });

  it('shows a danger dot when any verification is contradicted', () => {
    renderStrip();
    const dot = screen.getByTitle('Some claims contradicted — check spec sheet');
    expect(dot.className).toContain('bg-danger');
    expect(dot.closest('a')).toHaveAttribute('href', '/hunts/11/models/Hyundai%20Ioniq%205');
  });

  it('shows a warning dot when verification is incomplete', () => {
    renderStrip();
    const dot = screen.getByTitle('Verification incomplete');
    expect(dot.className).toContain('bg-warning');
    expect(dot.closest('a')).toHaveAttribute('href', '/hunts/11/models/VW%20ID.4');
  });

  it('shows a neutral dot when the target has no KB', () => {
    renderStrip();
    const dot = screen.getByTitle('No spec knowledge base yet');
    expect(dot.className).toContain('bg-zinc-600');
    expect(dot.closest('a')).toHaveAttribute('href', '/hunts/11/models/Skoda%20Enyaq');
  });

  it('treats a KB target with zero verifications as incomplete, not verified', () => {
    renderStrip([target('Kia EV6', kb(3), [])]);
    const dot = screen.getByTitle('Verification incomplete');
    expect(dot.className).toContain('bg-warning');
  });
});

describe('TargetsStrip — empty state', () => {
  it('renders nothing with no targets', () => {
    const { container } = renderStrip([]);
    expect(container.firstChild).toBeNull();
  });
});
