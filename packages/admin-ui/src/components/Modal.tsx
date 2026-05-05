import { ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./Button";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

const SIZE = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl" };

export function Modal({ open, onClose, title, description, children, footer, size = "md" }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastActive = useRef<HTMLElement | null>(null);
  // Latest-onClose ref — the keydown handler reads this, but the effect
  // does NOT depend on `onClose` directly. Otherwise every parent
  // re-render (e.g. the input's setState on each keystroke) creates a
  // fresh arrow-fn `onClose`, which would re-fire the effect, restart
  // the auto-focus setTimeout, and yank focus out of the textarea on
  // every key press. Pin the deps to `[open]` only.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Restore focus to the trigger after close, ESC closes, focus traps in
  // dialog. Auto-focus the first sensible input/textarea on open.
  useEffect(() => {
    if (!open) return;
    lastActive.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    // Auto-focus the first input-like element after mount. `textarea`
    // and `[autofocus]` belong here too — without them, the focus falls
    // through to the first non-close button (Cancel/Save), which is
    // wrong for a modal whose primary control is a textbox.
    setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'input, textarea, [autofocus], button:not([data-close]), [href]',
      );
      first?.focus();
    }, 10);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      lastActive.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        ref={dialogRef}
        className={cn(
          "relative w-full rounded-xl border border-rule bg-panel shadow-modal animate-scale-in",
          SIZE[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <div className="space-y-1">
            <h2 id="modal-title" className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <div className="text-sm text-dim">{description}</div>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            data-close
            aria-label="close"
            className="-mr-1 -mt-1 h-7 w-7 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children ? <div className="px-5 pb-4">{children}</div> : null}
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-rule px-5 py-3 bg-subtle/40 rounded-b-xl">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
