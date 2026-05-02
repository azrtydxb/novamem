import { createContext, ReactNode, useCallback, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from "lucide-react";
import { cn } from "../lib/utils";

type Tone = "success" | "warning" | "danger" | "info";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  push: (t: Omit<Toast, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastCtx = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const ICON: Record<Tone, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
  info: Info,
};

const TONE: Record<Tone, string> = {
  success: "border-success/40 bg-success-subtle/80",
  warning: "border-warning/40 bg-warning-subtle/80",
  danger: "border-danger/40 bg-danger-subtle/80",
  info: "border-accent/40 bg-accent-subtle/80",
};

const ICON_TONE: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-accent",
};

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastContextValue["push"]>(
    (t) => {
      const id = ++counter;
      setToasts((cur) => [...cur, { ...t, id }]);
      window.setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const value: ToastContextValue = {
    push,
    success: (title, description) => push({ tone: "success", title, description }),
    error: (title, description) => push({ tone: "danger", title, description }),
    info: (title, description) => push({ tone: "info", title, description }),
  };

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed top-4 right-4 z-[60] flex flex-col gap-2 w-[320px]">
          {toasts.map((t) => {
            const Icon = ICON[t.tone];
            return (
              <div
                key={t.id}
                className={cn(
                  "pointer-events-auto flex items-start gap-3 rounded-lg border bg-bg-panel/95 backdrop-blur p-3 shadow-card animate-slide-in-right",
                  TONE[t.tone],
                )}
              >
                <Icon className={cn("h-4 w-4 mt-0.5 flex-none", ICON_TONE[t.tone])} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text">{t.title}</div>
                  {t.description ? (
                    <div className="text-xs text-text-muted mt-0.5 break-words">
                      {t.description}
                    </div>
                  ) : null}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  className="text-text-subtle hover:text-text"
                  aria-label="dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

