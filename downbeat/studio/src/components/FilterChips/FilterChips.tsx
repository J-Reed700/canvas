import './FilterChips.css';
import React from 'react';

/** One chip for each kind there is, with how many. A chip that would match everything is left out, and the
 * chips are hidden when that leaves only All. */
export const FilterChips: React.FC<{
  kinds: [string, string][];
  counts: Record<string, number>;
  value: string;
  onChange: (kind: string) => void;
}> = ({ kinds, counts, value, onChange }) => {
  const shown = kinds.filter(([k]) => counts[k] && (k === 'all' || k === value || counts[k] < counts.all));
  if (shown.length < 2) return null;
  return (
    <div className="exp-kinds">
      {shown.map(([k, label]) => (
        <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label} <small>{counts[k]}</small>
        </button>
      ))}
    </div>
  );
};
