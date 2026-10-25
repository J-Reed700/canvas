import './TransitionPicker.css';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TRANSITIONS } from '../../engine/shaders.ts';
import { TRANSITION_CATALOG, TRANSITION_GROUPS, TRANSITION_POOLS } from '../../engine/transitionCatalog.ts';
import type { TransitionType } from '../../engine/types.ts';
import { Modal } from '../Modal/Modal.tsx';
import { Pager } from '../Pager/Pager.tsx';
import { SearchField } from '../SearchField/SearchField.tsx';

const PAGE_SIZE = 8;
const typeClass = (type: TransitionType) => `transition-type-${type.toLowerCase().replace(/[^a-z]+/g, '-')}`;

export interface TransitionPickerProps {
  value: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  context?: string;
}

/** The edit's transition pool and a single appearance use the same catalog and browser. */
export const TransitionPicker: React.FC<TransitionPickerProps> = ({ value, onChange, multiple = false, disabled, context }) => {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = value.map((id) => TRANSITIONS[id]).filter(Boolean);
  return <>
    <button ref={trigger} type="button" className="transition-picker-trigger" aria-haspopup="dialog" aria-expanded={open}
      aria-label={multiple ? 'Browse transitions' : 'Choose transition'} disabled={disabled}
      onClick={() => setOpen(true)}>
      <span className="transition-picker-mark" aria-hidden="true">↗</span>
      <span className="transition-picker-copy">
        <strong>{multiple ? `${selected.length} transition${selected.length === 1 ? '' : 's'} selected` : selected[0]?.name || 'Choose a transition'}</strong>
        <small>{multiple ? selected.slice(0, 2).map((transition) => transition.name).join(' · ') + (selected.length > 2 ? ` +${selected.length - 2}` : '') : selected[0]?.type || 'Explore the library'}</small>
      </span>
      <span className="transition-picker-browse">Browse <span aria-hidden="true">›</span></span>
    </button>
    {open && <TransitionBrowser value={value} onChange={onChange} multiple={multiple} disabled={disabled} context={context}
      returnFocusRef={trigger} onClose={() => setOpen(false)} />}
  </>;
};

const TransitionBrowser: React.FC<TransitionPickerProps & { onClose: () => void; returnFocusRef: React.RefObject<HTMLButtonElement | null> }> = ({ value, onChange, multiple, disabled, context, onClose, returnFocusRef }) => {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TransitionType | 'all'>('all');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  const caption = useId();
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    search.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close.current();
      } else if (event.key === 'Tab') {
        const controls = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || []);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !root.current?.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !root.current?.contains(document.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); returnFocus?.focus(); };
  }, [returnFocusRef]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = TRANSITION_CATALOG.filter((transition) => {
    const text = `${transition.id} ${transition.name} ${transition.type} ${transition.description}`.toLowerCase();
    return words.every((word) => text.includes(word)) && (!selectedOnly || value.includes(transition.id));
  });
  const filtered = matches.filter((transition) => type === 'all' || transition.type === type);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const pool = Object.entries(TRANSITION_POOLS).find(([, ids]) => ids.length === value.length && ids.every((id) => value.includes(id)))?.[0] || '';
  const choose = (id: string, only = false) => {
    if (disabled) return;
    if (!multiple || only) onChange([id]);
    else if (!value.includes(id)) onChange([...value, id]);
    else if (value.length > 1) onChange(value.filter((item) => item !== id));
    if (!multiple) onClose();
  };

  return createPortal(
    <div ref={root} className="transition-browser-overlay" data-pop data-modal-blocks-shortcuts onKeyDown={(event) => event.stopPropagation()}>
      <Modal open onClose={onClose} title="Transitions" ariaLabel="Transition library" ariaModal className="transition-browser"
        subtitle={`${TRANSITION_CATALOG.length} transitions · ${TRANSITION_GROUPS.length} types${context ? ` · ${context}` : ''}`}>
        <div className="transition-toolbar">
          <SearchField value={query} onChange={(next) => { setQuery(next); setPage(0); }} inputRef={search}
            ariaLabel="Search transitions" placeholder="Search by name, type or style…" />
          {multiple && <label className="transition-selected-filter"><input type="checkbox" checked={selectedOnly}
            onChange={(event) => { setSelectedOnly(event.target.checked); setPage(0); }} /> Selected only <span>{value.length}</span></label>}
        </div>
        <div className="transition-browser-body">
          <nav className="transition-types" aria-label="Transition types">
            <span className="transition-eyebrow">Browse by type</span>
            <button type="button" aria-pressed={type === 'all'} aria-label="All types" className={type === 'all' ? 'on' : ''}
              onClick={() => { setType('all'); setPage(0); }}>All types <span>{matches.length}</span></button>
            {TRANSITION_GROUPS.map((group) => <button type="button" key={group.type} aria-label={group.type}
              className={type === group.type ? 'on' : ''} aria-pressed={type === group.type}
              onClick={() => { setType(group.type); setPage(0); }}>{group.type}<span>{matches.filter((transition) => transition.type === group.type).length}</span></button>)}
          </nav>
          <div className="transition-results">
            <div className="transition-results-heading">
              <p id={caption}>{multiple ? 'Build your transition pool' : 'Choose the transition into this appearance'}<small>{multiple ? 'Changes apply as you select. Use Only to isolate a transition.' : 'Choose a transition to apply it to this cut.'}</small></p>
              {multiple && <label className="transition-preset">Selection preset<select aria-label="Transition selection preset" value={pool} disabled={disabled}
                onChange={(event) => onChange([...TRANSITION_POOLS[event.target.value]])}>
                <option value="" disabled>Custom selection</option>
                {Object.keys(TRANSITION_POOLS).map((name) => <option key={name} value={name}>{name}</option>)}
              </select></label>}
            </div>
            <div className="transition-table-scroll">
              <table className="transition-table" aria-label="Available transitions" aria-describedby={caption}>
                <thead><tr><th scope="col">Transition</th><th scope="col" className="transition-use-column">{multiple ? 'Include' : 'Use'}</th></tr></thead>
                {TRANSITION_GROUPS.map((group) => {
                  const entries = visible.filter((transition) => transition.type === group.type);
                  return entries.length > 0 && <tbody key={group.type}>
                    <tr className="transition-group-row"><th colSpan={2} scope="rowgroup">{group.type}<span>{filtered.filter((transition) => transition.type === group.type).length} transitions</span></th></tr>
                    {entries.map((transition) => {
                      const active = value.includes(transition.id);
                      return <tr key={transition.id} className={active ? 'is-selected' : ''} data-transition-id={transition.id}>
                        <td><div className="transition-name"><span className={`transition-swatch ${typeClass(transition.type)}`} aria-hidden="true"><i /><b /></span>
                          <span><strong>{transition.name}</strong><small>{transition.description}</small></span></div></td>
                        <td className="transition-use-column">{multiple ? <div className="transition-row-actions">
                          <input type="checkbox" aria-label={`Include ${transition.name}`} checked={active} disabled={disabled || active && value.length === 1}
                            title={active && value.length === 1 ? 'Keep at least one transition selected' : undefined} onChange={() => choose(transition.id)} />
                          <button type="button" disabled={disabled} aria-label={`Use only ${transition.name}`} onClick={() => choose(transition.id, true)}>Only</button>
                        </div> : <button type="button" disabled={disabled} className={`transition-use ${active ? 'on' : ''}`} aria-pressed={active}
                          aria-label={`Use ${transition.name}`} onClick={() => choose(transition.id)}>{active ? 'Selected' : 'Use'}</button>}</td>
                      </tr>;
                    })}
                  </tbody>;
                })}
              </table>
              {!filtered.length && <div className="transition-empty" role="status"><strong>No transitions found</strong><p>Try another name or explore a different type.</p>
                <button type="button" className="btn sm" onClick={() => { setQuery(''); setType('all'); setSelectedOnly(false); setPage(0); search.current?.focus(); }}>Clear filters</button></div>}
            </div>
            <div className="transition-pagination">
              <span role="status">{filtered.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length}` : '0 results'}</span>
              <Pager page={currentPage} pages={pages} onPage={setPage} />
            </div>
          </div>
        </div>
        <div className="transition-browser-footer"><span>{multiple ? `${value.length} selected · Used across the edit` : context || 'Only this appearance'}</span>
          <button type="button" className="btn primary" onClick={onClose}>{multiple ? 'Done' : 'Back to appearance'}</button></div>
      </Modal>
    </div>, document.body,
  );
};
