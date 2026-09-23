"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "./button";

/** Minimal accessible modal built on the native <dialog> element — handles focus trapping and Escape natively. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
      className="m-auto w-[min(92vw,900px)] rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/40 open:animate-[modal-in_180ms_ease-out]"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
