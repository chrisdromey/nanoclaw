/**
 * WP2: MustHaveChips — status icons/colors for standard / optional /
 * not-listed matches, in compact and full modes.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import MustHaveChips from '../components/verticals/cars/MustHaveChips';
import type { NormalisedFeatureCategory } from '@shared/types';

const features: NormalisedFeatureCategory[] = [
  {
    category: 'Driver Convenience',
    items: [
      { name: 'Adaptive Cruise Control with Stop & Go', type: 'Standard' },
      { name: 'Heat Pump', type: 'Optional' },
    ],
  },
  {
    category: 'Safety',
    items: [{ name: 'Lane Departure Warning', type: 'Standard' }],
  },
];

const mustHaves = [
  'Adaptive cruise control (ACC)', // standard match
  'Heat pump', // optional match
  'Ventilated seats', // not listed
];

describe('MustHaveChips — compact mode', () => {
  it('renders all three statuses with the right icons', () => {
    render(<MustHaveChips mustHaves={mustHaves} features={features} mode="compact" />);
    expect(screen.getByText('✓')).toBeInTheDocument();
    expect(screen.getByText('⚠')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('shortens labels to significant words and carries detail in the title attr', () => {
    render(<MustHaveChips mustHaves={mustHaves} features={features} mode="compact" />);
    // "Adaptive cruise control (ACC)" → parenthetical stripped, first 3 words
    const accChip = screen.getByText('adaptive cruise control').closest('span[title]');
    expect(accChip).toHaveAttribute(
      'title',
      expect.stringContaining('standard: Adaptive Cruise Control with Stop & Go'),
    );
    expect(accChip).toHaveAttribute('title', expect.stringContaining('Driver Convenience'));

    const heatChip = screen.getByText('heat pump').closest('span[title]');
    expect(heatChip).toHaveAttribute(
      'title',
      expect.stringContaining('optional pack — verify with dealer'),
    );

    const ventChip = screen.getByText('ventilated seats').closest('span[title]');
    expect(ventChip).toHaveAttribute('title', expect.stringContaining('not listed'));
  });

  it('applies status colors', () => {
    render(<MustHaveChips mustHaves={mustHaves} features={features} mode="compact" />);
    expect(screen.getByText('adaptive cruise control').closest('span[title]')).toHaveClass('text-success');
    expect(screen.getByText('heat pump').closest('span[title]')).toHaveClass('text-warning');
    expect(screen.getByText('ventilated seats').closest('span[title]')).toHaveClass('text-zinc-500');
  });
});

describe('MustHaveChips — full mode', () => {
  it('renders stacked rows with explicit status text', () => {
    render(<MustHaveChips mustHaves={mustHaves} features={features} mode="full" />);
    expect(screen.getByText('standard')).toBeInTheDocument();
    expect(screen.getByText('optional pack — verify with dealer')).toBeInTheDocument();
    expect(screen.getByText('not listed')).toBeInTheDocument();
    // Full (untruncated) must-have strings appear
    expect(screen.getByText('Adaptive cruise control (ACC)')).toBeInTheDocument();
    expect(screen.getByText('Ventilated seats')).toBeInTheDocument();
  });

  it('shows the matched feature and category for matched must-haves', () => {
    render(<MustHaveChips mustHaves={mustHaves} features={features} mode="full" />);
    expect(
      screen.getByText(/Adaptive Cruise Control with Stop & Go · Driver Convenience/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Heat Pump · Driver Convenience/)).toBeInTheDocument();
  });

  it('does not show a matched-feature line for not-listed must-haves', () => {
    render(<MustHaveChips mustHaves={['Ventilated seats']} features={features} mode="full" />);
    expect(screen.getByText('not listed')).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });
});

describe('MustHaveChips — empty input', () => {
  it('renders nothing when there are no must-haves', () => {
    const { container } = render(
      <MustHaveChips mustHaves={[]} features={features} mode="compact" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('marks everything not listed when the listing has no features', () => {
    render(<MustHaveChips mustHaves={mustHaves} features={[]} mode="compact" />);
    expect(screen.getAllByText('?')).toHaveLength(3);
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });
});
