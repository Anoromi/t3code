import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { MAX_READ_ALOUD_WPM, MIN_READ_ALOUD_WPM, normalizeReadAloudWpm } from "./readAloudSettings";

type ReadAloudWpmPopoverVariant = "overlay" | "settings";

interface ReadAloudWpmPopoverControlProps {
  readonly value: number;
  readonly onChange: (nextWpm: number) => void;
  readonly disabled?: boolean;
  readonly variant?: ReadAloudWpmPopoverVariant;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly popupSide?: "top" | "bottom";
  readonly popupAlign?: "start" | "center" | "end";
}

const COMMIT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

export function ReadAloudWpmPopoverControl({
  value,
  onChange,
  disabled = false,
  variant = "overlay",
  className,
  triggerClassName,
  popupSide = variant === "overlay" ? "top" : "bottom",
  popupAlign = variant === "overlay" ? "center" : "end",
}: ReadAloudWpmPopoverControlProps) {
  const [open, setOpen] = useState(false);
  const [draftWpm, setDraftWpm] = useState(() => normalizeReadAloudWpm(value));
  const [inputDraft, setInputDraft] = useState(() => String(normalizeReadAloudWpm(value)));
  const editingRef = useRef(false);
  const latestDraftRef = useRef(draftWpm);
  const latestValueRef = useRef(value);

  useEffect(() => {
    latestDraftRef.current = draftWpm;
  }, [draftWpm]);

  useEffect(() => {
    latestValueRef.current = value;
    if (!editingRef.current) {
      const normalized = normalizeReadAloudWpm(value);
      setDraftWpm(normalized);
      setInputDraft(String(normalized));
    }
  }, [value]);

  const commit = useCallback(
    (nextValue: number) => {
      const normalized = normalizeReadAloudWpm(nextValue);
      editingRef.current = false;
      latestDraftRef.current = normalized;
      setDraftWpm(normalized);
      setInputDraft(String(normalized));
      if (normalized !== normalizeReadAloudWpm(latestValueRef.current)) {
        onChange(normalized);
      }
    },
    [onChange],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        commit(latestDraftRef.current);
      }
      setOpen(nextOpen);
    },
    [commit],
  );

  const handleSliderKeyUp = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (COMMIT_KEYS.has(event.key)) {
        commit(Number(event.currentTarget.value));
      }
    },
    [commit],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      const nextInput = event.currentTarget.value.trim();
      commit(nextInput.length > 0 ? Number(nextInput) : latestDraftRef.current);
      event.currentTarget.blur();
    },
    [commit],
  );

  const triggerValue = open ? draftWpm : normalizeReadAloudWpm(value);
  const isOverlay = variant === "overlay";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={isOverlay ? "ghost" : "outline"}
            size={isOverlay ? "xs" : "default"}
            disabled={disabled}
            aria-label="Read-aloud WPM"
            className={cn(
              isOverlay
                ? "h-5 rounded-md border-transparent bg-transparent px-1.5 font-mono text-[10px] text-foreground hover:bg-accent"
                : "w-full justify-between sm:w-40",
              triggerClassName,
            )}
          >
            <span className="tabular-nums">{triggerValue}</span>
            <span className={cn("text-muted-foreground", isOverlay ? "text-[9px]" : "text-xs")}>
              WPM
            </span>
            <ChevronDownIcon className={cn("opacity-50", isOverlay ? "size-3" : "size-4")} />
          </Button>
        }
      />
      <PopoverPopup
        side={popupSide}
        align={popupAlign}
        sideOffset={8}
        className={cn("w-52 p-0", className)}
      >
        <div className="grid gap-3 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-foreground">WPM</span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {draftWpm} WPM
            </span>
          </div>
          <div className="grid gap-1.5">
            <input
              className="w-full accent-primary"
              type="range"
              min={MIN_READ_ALOUD_WPM}
              max={MAX_READ_ALOUD_WPM}
              step={10}
              value={draftWpm}
              aria-label="Read-aloud WPM"
              onChange={(event) => {
                editingRef.current = true;
                const nextValue = Number(event.currentTarget.value);
                setDraftWpm(nextValue);
                setInputDraft(String(nextValue));
              }}
              onBlur={(event) => commit(Number(event.currentTarget.value))}
              onKeyUp={handleSliderKeyUp}
              onPointerUp={(event) => commit(Number(event.currentTarget.value))}
              onTouchEnd={(event) => commit(Number(event.currentTarget.value))}
            />
            <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground/80 tabular-nums">
              <span>{MIN_READ_ALOUD_WPM}</span>
              <span>{MAX_READ_ALOUD_WPM}</span>
            </div>
          </div>
          <Input
            className="h-7 font-mono text-xs tabular-nums"
            type="number"
            min={MIN_READ_ALOUD_WPM}
            max={MAX_READ_ALOUD_WPM}
            step={10}
            value={inputDraft}
            aria-label="Read-aloud WPM value"
            onChange={(event) => {
              editingRef.current = true;
              const nextInput = event.currentTarget.value;
              setInputDraft(nextInput);
              if (nextInput.trim().length === 0) return;
              const nextValue = Number(nextInput);
              if (Number.isFinite(nextValue)) {
                setDraftWpm(nextValue);
              }
            }}
            onBlur={(event) => {
              const nextInput = event.currentTarget.value.trim();
              commit(nextInput.length > 0 ? Number(nextInput) : latestDraftRef.current);
            }}
            onKeyDown={handleInputKeyDown}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
