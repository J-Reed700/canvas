import React from 'react';

export const ShortcutItem: React.FC<{ kbd: string; desc: string }> = ({ kbd, desc }) => (
  <React.Fragment key={kbd}>
    <span className="kbd">{kbd}</span>
    <span>{desc}</span>
  </React.Fragment>
);
