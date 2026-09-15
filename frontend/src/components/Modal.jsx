import React, { useEffect, useRef, useCallback } from 'react';

/**
 * Modal — accessible dialog primitive.
 *
 * Features:
 * - role="dialog", aria-modal="true", aria-labelledby + aria-describedby wiring
 * - Esc-to-close
 * - Click-outside-to-close (configurable)
 * - Focus trap inside the panel (Tab / Shift+Tab cycle through focusables)
 * - Focus restoration to the previously-focused element on close
 * - Body scroll lock while open
 * - Smooth fade + scale transition
 *
 * Usage:
 *   <Modal open={open} onClose={close} title="Edit rate" description="…">
 *     …children…
 *   </Modal>
 *
 * Or compose with ConfirmDialog for delete confirmations.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md', // sm | md | lg | xl | full
  closeOnBackdrop = true,
  initialFocusRef,
  hideCloseButton = false,
  footer,
  className = '',
}) {
  const panelRef = useRef(null);
  const titleIdRef = useRef(`modal-title-${Math.random().toString(36).slice(2, 9)}`);
  const descIdRef  = useRef(`modal-desc-${Math.random().toString(36).slice(2, 9)}`);
  const previouslyFocusedRef = useRef(null);

  const sizes = {
    sm:  'max-w-md',
    md:  'max-w-lg',
    lg:  'max-w-2xl',
    xl:  'max-w-4xl',
    full:'max-w-[min(96vw,1200px)]',
  };

  // Save focus, lock scroll, restore on close
  useEffect(() => {
    if (!open) return undefined;
    previouslyFocusedRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch { /* element may have unmounted */ }
      }
    };
  }, [open]);

  // Esc to close
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus trap + initial focus
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const applyFocus = () => {
      const initial = initialFocusRef?.current || panel.querySelector(FOCUSABLE_SELECTOR);
      if (initial && typeof initial.focus === 'function') {
        try { initial.focus(); } catch { /* noop */ }
      } else {
        // Fall back to the panel itself so screen readers announce it.
        panel.focus();
      }
    };

    // Apply on next frame so the modal is in the DOM tree.
    const id = requestAnimationFrame(applyFocus);

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const focusables = Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last  = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(id);
      panel.removeEventListener('keydown', onKeyDown);
    };
  }, [open, initialFocusRef]);

  const handleBackdropClick = useCallback((e) => {
    if (!closeOnBackdrop) return;
    if (e.target === e.currentTarget) onClose?.();
  }, [closeOnBackdrop, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="presentation"
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={handleBackdropClick}
        className="absolute inset-0 bg-slate-900/45 backdrop-blur-[3px] animate-[modal-fade-in_180ms_ease-out]"
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleIdRef.current : undefined}
        aria-describedby={description ? descIdRef.current : undefined}
        tabIndex={-1}
        className={`relative w-full ${sizes[size] || sizes.md} bg-surface rounded-2xl border border-border shadow-2xl outline-none animate-[modal-pop-in_220ms_cubic-bezier(.2,.9,.3,1)] flex flex-col max-h-[min(92vh,820px)] ${className}`}
      >
        {/* Header */}
        {(title || !hideCloseButton) && (
          <div className="px-6 py-4 border-b border-border flex items-start gap-4">
            <div className="flex-1 min-w-0">
              {title && (
                <h2
                  id={titleIdRef.current}
                  className="font-display text-headline-sm font-semibold text-ink"
                >
                  {title}
                </h2>
              )}
              {description && (
                <p
                  id={descIdRef.current}
                  className="text-body-sm text-outline mt-0.5"
                >
                  {description}
                </p>
              )}
            </div>
            {!hideCloseButton && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="-m-2 p-2 rounded-lg text-outline hover:text-ink hover:bg-surface-container-low transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M6 18L18 6" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-6 py-4 border-t border-border bg-surface-container-low/40 rounded-b-2xl">
            {footer}
          </div>
        )}
      </div>

      {/* Keyframes (scoped to ensure presence even if global css is missing) */}
      <style>{`
        @keyframes modal-fade-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes modal-pop-in {
          from { opacity: 0; transform: translateY(8px) scale(.97) }
          to   { opacity: 1; transform: translateY(0)   scale(1) }
        }
        @media (prefers-reduced-motion: reduce) {
          [role=dialog], [aria-hidden=true] { animation: none !important }
        }
      `}</style>
    </div>
  );
}

/**
 * ConfirmDialog — composes Modal for destructive confirmations.
 * Replaces window.confirm so the experience stays on-brand and accessible.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger', // danger | primary
  busy = false,
}) {
  const cancelRef = useRef(null);
  const handleConfirm = async () => {
    if (busy) return;
    await onConfirm?.();
  };
  const palette = variant === 'danger'
    ? { btn: 'bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-500', iconBg: 'bg-rose-100', iconColor: 'text-rose-600' }
    : { btn: 'bg-primary hover:bg-primary/90 focus-visible:ring-primary', iconBg: 'bg-primary/15', iconColor: 'text-primary' };
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      description={description}
      size="sm"
      closeOnBackdrop={!busy}
      initialFocusRef={cancelRef}
      hideCloseButton={busy}
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={busy ? undefined : onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-secondary border border-border bg-surface hover:bg-surface-container-low transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${palette.btn}`}
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                </svg>
                Working…
              </span>
            ) : confirmLabel}
          </button>
        </div>
      }
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${palette.iconBg} ${palette.iconColor}`}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75M12 17.25h.008v.008H12v-.008zM10.29 3.86l-8.18 14.18A2 2 0 003.84 21h16.32a2 2 0 001.73-2.96L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <p className="text-body-sm text-secondary leading-relaxed">{description}</p>
      </div>
    </Modal>
  );
}
