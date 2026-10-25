import React from 'react';
import { SearchField } from '../SearchField/SearchField.tsx';

/** A search field whose Escape clears the search before it closes anything. */
export const FilterSearch: React.FC<{
  value: string;
  onChange: (q: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}> = ({ value, onChange, placeholder, autoFocus, inputRef }) => (
  <SearchField
    value={value}
    onChange={onChange}
    placeholder={placeholder}
    autoFocus={autoFocus}
    inputRef={inputRef}
    onKeyDown={(e) => {
      if (e.key === 'Escape' && value) {
        e.stopPropagation();
        onChange('');
      }
    }}
  />
);
