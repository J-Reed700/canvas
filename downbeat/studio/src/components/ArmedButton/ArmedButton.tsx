import React from 'react';
import { useArmed } from '../../hooks/useArmed.ts';

export interface ArmedButtonProps {
  onConfirm: () => void;
  label?: React.ReactNode;
  armedLabel?: React.ReactNode;
  className?: string;
  title?: string;
  armedTitle?: string;
  ms?: number;
  children?: React.ReactNode;
}

export const ArmedButton: React.FC<ArmedButtonProps> = ({
  onConfirm,
  label = 'Delete',
  armedLabel = 'Click again to confirm',
  className = '',
  title = 'Delete',
  armedTitle = 'Click again to confirm',
  ms = 3000,
  children,
}) => {
  const [armed, setArmed] = useArmed(ms);
  return (
    <button
      className={`btn ${armed ? 'armed' : ''} ${className}`.trim()}
      title={armed ? armedTitle : title}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? armedLabel : (children || label)}
    </button>
  );
};
