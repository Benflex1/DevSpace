import { useCallback, useEffect, useRef, useState } from "react";

export type TransientNoticeKind = "pending" | "info" | "success" | "error";

export interface TransientNotice {
  readonly message: string;
  readonly kind: TransientNoticeKind;
  readonly referenceId?: string;
}

export const TRANSIENT_NOTICE_DISMISS_MS = 4_000;

export function transientNoticeDismissDelay(kind: TransientNoticeKind): number | null {
  return kind === "pending" || kind === "error" ? null : TRANSIENT_NOTICE_DISMISS_MS;
}

export function useTransientNotice(initialMessage: string | null = null): {
  readonly notice: TransientNotice | null;
  readonly show: (message: string, kind: TransientNoticeKind, referenceId?: string) => void;
  readonly clear: () => void;
} {
  const [notice, setNotice] = useState<TransientNotice | null>(
    initialMessage === null || initialMessage === "" ? null : { message: initialMessage, kind: "error" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const clear = useCallback(() => {
    clearTimer();
    setNotice(null);
  }, [clearTimer]);
  const show = useCallback((message: string, kind: TransientNoticeKind, referenceId?: string) => {
    clearTimer();
    setNotice({ message, kind, ...(referenceId === undefined ? {} : { referenceId }) });
    const delay = transientNoticeDismissDelay(kind);
    if (delay === null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setNotice(null);
    }, delay);
  }, [clearTimer]);
  useEffect(() => () => clearTimer(), [clearTimer]);
  return { notice, show, clear };
}
