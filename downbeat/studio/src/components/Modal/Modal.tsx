import './Modal.css';
import React from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  subtitleId?: string;
  headerActions?: React.ReactNode;
  className?: string;
  ariaLabel?: string;
  ariaModal?: boolean;
  closeButtonDataAction?: string;
  id?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  subtitle,
  subtitleId,
  headerActions,
  className = '',
  ariaLabel,
  ariaModal,
  closeButtonDataAction,
  id,
  style,
  children,
}) => {
  if (!open && !id) return null;
  const computedAriaLabel = ariaLabel || (typeof title === 'string' ? title : undefined);

  return (
    <div
      className={`modal-bg ${open ? 'on' : ''}`}
      id={id}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-close]')) {
          onClose();
        }
      }}
    >
      {open && (
        <div
          className={`modal ${className}`.trim()}
          role="dialog"
          aria-label={computedAriaLabel}
          aria-modal={ariaModal}
          style={style}
        >
          <div className="modal-h">
            <div>
              {typeof title === 'string' ? <h2>{title}</h2> : title}
              {subtitle && (
                React.isValidElement(subtitle) ? (
                  subtitle
                ) : (
                  <div className="sub modal-sub" id={subtitleId}>
                    {subtitle}
                  </div>
                )
              )}
            </div>
            {headerActions}
            <button
              className="btn icon modal-x"
              data-close
              data-action={closeButtonDataAction}
              title="Close (Esc)"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
};
