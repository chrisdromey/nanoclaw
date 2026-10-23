/**
 * JevChecks — verdict pills and probability bars for Jev must-have verdicts.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import JevChecks, { barWidth } from '../components/JevChecks';
import type { JevCheck } from '@shared/types';

const checks: JevCheck[] = [
  {
    offer_id: 1, hunt_id: 11, hunt_name: 'family-ev', requirement: 'Adaptive Cruise Control (ACC)',
    verdict: 'verified', evidence: 'Drivers Assistance / Smart Cruise Control with Stop and Go (Standard)', confidence: 0.9,
    probabilities: [
      { label: 'Drivers Assistance / Smart Cruise Control with Stop and Go (Standard)', p: 0.9 },
      { label: 'none', p: 0.08 },
      { label: 'Derivative: 73kWh Premium Auto 5dr', p: 0.02 },
    ],
    model: 'jev-1.13.0', checked_at: '2026-09-20 20:00:00',
  },
  {
    offer_id: 1, hunt_id: 11, hunt_name: 'family-ev', requirement: 'Lane Keep Assist or Lane Centering',
    verdict: 'contradicted', evidence: 'Not in the listed equipment (40 lines checked)', confidence: 0.95,
    probabilities: [{ label: 'none', p: 0.95 }, { label: 'Safety / Lane Departure Warning (Standard)', p: 0.05 }],
    model: 'jev-1.13.0', checked_at: '2026-09-20 20:00:00',
  },
];

describe('JevChecks', () => {
  it('renders a verdict pill, confidence and a bar per candidate line', () => {
    render(<JevChecks checks={checks} />);
    expect(screen.getByText('verified')).toBeInTheDocument();
    expect(screen.getByText('contradicted')).toBeInTheDocument();
    expect(screen.getByText('90% sure')).toBeInTheDocument();
    expect(screen.getAllByText('Not in the equipment list')).toHaveLength(2);
    expect(screen.getByTestId('jev-bar-0-0')).toHaveStyle({ width: '90%' });
    expect(screen.getByTestId('jev-bar-1-0')).toHaveStyle({ width: '95%' });
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(<JevChecks checks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('floors bar width so tiny probabilities stay visible', () => {
    expect(barWidth(0.001)).toBe('2%');
    expect(barWidth(0.457)).toBe('45.7%');
  });
});
