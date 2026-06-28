import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPut } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { formatPrice } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Hunt } from '@shared/types';
import { Pencil, Save, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface SettingsTabProps {
  huntId: number;
  hunt: Hunt;
}

export default function SettingsTab({ huntId, hunt }: SettingsTabProps) {
  const queryClient = useQueryClient();
  const [editingCadence, setEditingCadence] = useState(false);
  const [editCadence, setEditCadence] = useState(0);
  const [editingCategories, setEditingCategories] = useState(false);
  const [editCategories, setEditCategories] = useState('');
  const [editing, setEditing] = useState(false);
  const [editTerms, setEditTerms] = useState<string[]>([]);
  const [newTerm, setNewTerm] = useState('');

  const criteria = (() => {
    try { return JSON.parse(hunt.criteria); } catch { return {}; }
  })();

  const searchTerms: Array<{ terms: string; category_ids?: string }> = (() => {
    try {
      const parsed = JSON.parse(hunt.search_terms);
      if (!Array.isArray(parsed)) return [];
      if (parsed.length === 0) return [];
      if (typeof parsed[0] === 'string') return parsed.map((t: string) => ({ terms: t }));
      return parsed;
    } catch { return []; }
  })();

  const invalidateHunt = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.hunts.detail(huntId) });
  };

  const saveCadence = async (value: number) => {
    try {
      await apiPut(`/hunts/${huntId}`, { cadence_minutes: value });
      toast.success(`Cadence updated to ${value}min`);
      setEditingCadence(false);
      invalidateHunt();
    } catch { toast.error('Failed to update cadence'); }
  };

  const saveCategories = async () => {
    try {
      await apiPut(`/hunts/${huntId}`, { category_ids: editCategories || null });
      toast.success('Categories updated');
      setEditingCategories(false);
      invalidateHunt();
    } catch { toast.error('Failed to update categories'); }
  };

  const toggleMonitoring = async () => {
    try {
      await apiPut(`/hunts/${huntId}`, { monitoring: hunt.monitoring ? 0 : 1 });
      toast.success(hunt.monitoring ? 'Monitoring disabled' : 'Monitoring enabled');
      invalidateHunt();
    } catch { toast.error('Failed to update monitoring'); }
  };

  const startEdit = () => {
    setEditTerms(searchTerms.map((e) => e.terms));
    setNewTerm('');
    setEditing(true);
  };

  const saveTerms = async () => {
    try {
      await apiPut(`/hunts/${huntId}`, { search_terms: editTerms });
      toast.success('Search terms updated');
      setEditing(false);
      invalidateHunt();
    } catch { toast.error('Failed to update search terms'); }
  };

  const addTerm = () => {
    const trimmed = newTerm.trim();
    if (trimmed && !editTerms.includes(trimmed)) {
      setEditTerms([...editTerms, trimmed]);
      setNewTerm('');
    }
  };

  const isClosed = hunt.status === 'closed';

  return (
    <div className="animate-feed-in max-w-2xl space-y-6">
      {/* Vertical (read-only) */}
      <section>
        <h3 className="text-heading text-zinc-300 mb-3">Vertical</h3>
        <div className="bg-surface border border-zinc-800 rounded-lg p-4 text-sm">
          <Row label="Vertical">
            <span className="font-mono text-zinc-300">{hunt.vertical || 'computers'}</span>
          </Row>
          {hunt.sources?.length > 0 && (
            <Row label="Sources">
              <span className="font-mono text-zinc-300">{hunt.sources.join(', ')}</span>
            </Row>
          )}
          {hunt.poll_interval_minutes != null && (
            <Row label="Poll interval">
              <span className="font-mono text-zinc-300">{hunt.poll_interval_minutes}min</span>
            </Row>
          )}
        </div>
      </section>

      {/* Criteria (read-only) */}
      <section>
        <h3 className="text-heading text-zinc-300 mb-3">Criteria</h3>
        <div className="bg-surface border border-zinc-800 rounded-lg p-4 space-y-2 text-sm">
          {criteria.budget && (
            <Row label="Budget">
              <span className="font-mono text-zinc-50">≤ {formatPrice(criteria.budget)}</span>
            </Row>
          )}
          {criteria.must_haves && (
            <Row label="Must-haves">
              <span className="text-zinc-300">
                {Array.isArray(criteria.must_haves) ? criteria.must_haves.join(', ') : criteria.must_haves}
              </span>
            </Row>
          )}
          {criteria.nice_to_haves && (
            <Row label="Nice-to-haves">
              <span className="text-zinc-400">
                {Array.isArray(criteria.nice_to_haves) ? criteria.nice_to_haves.join(', ') : criteria.nice_to_haves}
              </span>
            </Row>
          )}
          {Object.keys(criteria).length === 0 && (
            <span className="text-zinc-600">No criteria set</span>
          )}
        </div>
      </section>

      {/* Search cadence */}
      <section>
        <h3 className="text-heading text-zinc-300 mb-3">Search Cadence</h3>
        <div className="bg-surface border border-zinc-800 rounded-lg p-4">
          {editingCadence ? (
            <select
              autoFocus
              value={editCadence}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                setEditCadence(val);
                saveCadence(val);
              }}
              onBlur={() => setEditingCadence(false)}
              className="bg-surface border border-accent rounded px-2 py-0.5 text-sm text-zinc-300 font-mono"
            >
              {[15, 30, 60, 120, 240].map((m) => (
                <option key={m} value={m}>Every {m}min</option>
              ))}
            </select>
          ) : (
            <button
              onClick={() => { setEditCadence(hunt.cadence_minutes); setEditingCadence(true); }}
              className={cn('text-sm text-zinc-300 hover:text-zinc-100 transition-colors', isClosed && 'pointer-events-none')}
              disabled={isClosed}
            >
              Every {hunt.cadence_minutes}min
              {!isClosed && <Pencil size={12} className="inline ml-2 text-zinc-500" />}
            </button>
          )}
        </div>
      </section>

      {/* Categories — eBay-specific; hidden for non-eBay hunts (e.g. cars/AutoTrader) */}
      {(hunt.sources?.includes('ebay') || hunt.vertical === 'computers' || !hunt.vertical) && <section>
        <h3 className="text-heading text-zinc-300 mb-3">eBay Categories</h3>
        <div className="bg-surface border border-zinc-800 rounded-lg p-4">
          {editingCategories ? (
            <span className="flex items-center gap-2">
              <input
                autoFocus
                value={editCategories}
                onChange={(e) => setEditCategories(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveCategories();
                  if (e.key === 'Escape') setEditingCategories(false);
                }}
                onBlur={() => saveCategories()}
                placeholder="e.g. 175672,171957"
                className="bg-surface border border-accent rounded px-2 py-0.5 text-sm text-zinc-300 font-mono w-48"
              />
            </span>
          ) : (
            <button
              onClick={() => { setEditCategories(hunt.category_ids || ''); setEditingCategories(true); }}
              className={cn('text-sm text-zinc-300 hover:text-zinc-100 transition-colors', isClosed && 'pointer-events-none')}
              disabled={isClosed}
            >
              {hunt.category_ids || <span className="text-zinc-500">None set</span>}
              {!isClosed && <Pencil size={12} className="inline ml-2 text-zinc-500" />}
            </button>
          )}
        </div>
      </section>}

      {/* Monitoring */}
      {!isClosed && (
        <section>
          <h3 className="text-heading text-zinc-300 mb-3">Monitoring</h3>
          <div className="bg-surface border border-zinc-800 rounded-lg p-4">
            <button
              onClick={toggleMonitoring}
              className={cn(
                'flex items-center gap-2 text-sm transition-colors',
                hunt.monitoring ? 'text-success hover:text-green-400' : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              <span className={cn('inline-block w-2.5 h-2.5 rounded-full', hunt.monitoring ? 'bg-success' : 'bg-zinc-600')} />
              {hunt.monitoring ? 'Monitoring active — click to disable' : 'Monitoring disabled — click to enable'}
            </button>
          </div>
        </section>
      )}

      {/* Search Terms */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-heading text-zinc-300">Search Terms</h3>
          {!editing && !isClosed && (
            <button onClick={startEdit} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
              <Pencil size={12} /> Edit
            </button>
          )}
          {editing && (
            <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
              <button onClick={saveTerms} className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover">
                <Save size={12} /> Save
              </button>
            </div>
          )}
        </div>
        <div className="bg-surface border border-zinc-800 rounded-lg p-4">
          {!editing ? (
            <div className="space-y-1.5">
              {searchTerms.map((entry, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-zinc-300">"{entry.terms}"</span>
                  {entry.category_ids && (
                    <span className="text-xs text-zinc-500">cat: {entry.category_ids}</span>
                  )}
                </div>
              ))}
              {searchTerms.length === 0 && (
                <span className="text-sm text-zinc-600">No search terms set</span>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {editTerms.map((term, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-zinc-300 flex-1">"{term}"</span>
                  <button onClick={() => setEditTerms(editTerms.filter((_, j) => j !== i))} className="text-zinc-500 hover:text-danger">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTerm}
                  onChange={(e) => setNewTerm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTerm()}
                  placeholder="Add search term..."
                  className="flex-1 px-2 py-1 text-sm bg-zinc-900 border border-zinc-700 rounded-md text-zinc-300 placeholder-zinc-600 focus:border-accent focus:outline-none"
                />
                <button onClick={addTerm} className="text-accent hover:text-accent-hover">
                  <Plus size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-zinc-500 w-24 shrink-0">{label}</span>
      {children}
    </div>
  );
}
