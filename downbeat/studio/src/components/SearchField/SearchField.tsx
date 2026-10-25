import './SearchField.css';
import React from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { ICONS } from '../Icon/icons.ts';

export const SearchField: React.FC<{
  value: string;
  onChange: (q: string) => void;
  placeholder: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  className?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}> = ({ value, onChange, placeholder, ariaLabel, autoFocus, className = '', inputRef, onKeyDown }) => (
  <label className={`exp-search ${className}`}>
    <Icon d={ICONS.search} />
    <input
      ref={inputRef}
      type="search"
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  </label>
);
