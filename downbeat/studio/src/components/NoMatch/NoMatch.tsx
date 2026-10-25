import './NoMatch.css';
import React from 'react';

export const NoMatch: React.FC<{ what: string; onClear: () => void }> = ({ what, onClear }) => (
  <div className="exp-empty">
    No {what} match.{' '}
    <button className="link" onClick={onClear}>
      Clear search
    </button>
  </div>
);
